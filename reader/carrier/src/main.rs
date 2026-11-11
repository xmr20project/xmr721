//! Mordinals carrier: the relay's own Monero wallet. It puts one MD1 record into an ordinary transaction (one input,
//! a small payment to itself plus change, normal decoys) and pays the network fee from its own coins.
//! Networks: an offline test chain, stagenet, or mainnet. Mainnet needs MORDINALS_MAINNET=1 as well, and a synchronized,
//! unrestricted node of its own (decoys come from that node).
//!
//!   mordinals-carrier <state dir> <op> [argument]        one JSON line on stdout
//!     init                  make the wallet keys (once) and print the address
//!     status                scan new blocks; balance, how many coins can carry a record now, and the payments
//!                           received at subaddresses given out with `address`
//!     carry <record hex>    build the carrier (not sent): {txid, blob, fee, extraBytes}
//!     split <n>             one transaction paying n coins of 0.01 XMR to this wallet (more carriers per block)
//!     publish <blob hex>    send a built transaction to the node
//!     address <n>           subaddress n of this wallet, for a fee payment; from then on every scan looks for it
//!   Environment: MORDINALS_NODE (http://127.0.0.1:port), MORDINALS_NETWORK (offline-fakechain | stagenet | mainnet),
//!   MORDINALS_MAINNET=1 (required for mainnet), MORDINALS_MAX_FEE (largest network fee of one transaction, atomic units),
//!   MORDINALS_START (first block to scan).
//!
//! Record framing in tx_extra is the XMR20 framing: tx public key, then 254-byte nonce chunks each marked 0x7f.
use anyhow::{ensure, Context, Result};
use curve25519_dalek::{constants::ED25519_BASEPOINT_POINT as G, scalar::Scalar as DS};
use monero_simple_request_rpc::{prelude::MoneroDaemon, SimpleRequestTransport};
use monero_wallet::{
    address::{MoneroAddress, Network, SubaddressIndex},
    ed25519::{Point, Scalar},
    interface::{prelude::*, FeeRate},
    ringct::RctType,
    send::{Change, SignableTransaction},
    transaction::{Input, Transaction},
    OutputWithDecoys, Scanner, ViewPair, WalletOutput,
};
use rand_core::{OsRng, RngCore};
use serde_json::{json, Value as J};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use zeroize::Zeroizing;

type Rpc = MoneroDaemon<SimpleRequestTransport>;
const MAGIC: &[u8; 4] = b"MD1\xfe";
const EXTRA_LIMIT: usize = 1060;
const CHUNK: usize = 254;
const MAX_RECORD: usize = 1000;
const SELF_PAYMENT: u64 = 1_000_000;
const SPLIT_COIN: u64 = 10_000_000_000;
// The least a coin must hold above what a transaction pays out, so it can cover the network fee many times over.
// A fee payment of 0.0005 XMR is large enough to carry a record itself.
const MIN_INPUT: u64 = 400_000_000;
const MAX_SUBADDRESSES: u32 = 100_000;

fn parts(record: &[u8]) -> Result<Vec<Vec<u8>>> {
    ensure!(record.len() > 5 && record.len() <= MAX_RECORD, "Record size out of range");
    ensure!(record.starts_with(MAGIC), "Not a Mordinals record");
    Ok(record.chunks(CHUNK).map(|c| c.to_vec()).collect())
}

async fn guard(r: &Rpc, network: &str) -> Result<()> {
    let j: J = serde_json::from_str(&r.json_rpc_call("get_info", None, 8192).await?)?;
    let main = j["mainnet"] == true || j["nettype"] == "mainnet";
    ensure!(!main || network == "mainnet", "Mainnet node refused: this wallet was opened for {network}");
    match network {
        "mainnet" => {
            ensure!(std::env::var("MORDINALS_MAINNET").as_deref() == Ok("1"), "Mainnet needs MORDINALS_MAINNET=1");
            ensure!(main && j["synchronized"] == true && j["restricted"] != true, "A synchronized, unrestricted mainnet node of your own is required (node reports {})", j["nettype"]);
        }
        "offline-fakechain" => ensure!(
            j["nettype"] == "fakechain" && j["offline"] == true && j["incoming_connections_count"] == 0 && j["outgoing_connections_count"] == 0,
            "Offline test chain required (node reports {})", j["nettype"]
        ),
        "stagenet" => ensure!(j["nettype"] == "stagenet" && j["stagenet"] == true, "Stagenet node required (node reports {})", j["nettype"]),
        other => anyhow::bail!("Unsupported network {other:?}"),
    }
    Ok(())
}

fn images<P: monero_wallet::transaction::PotentiallyPruned>(tx: &Transaction<P>) -> Vec<[u8; 32]> {
    tx.prefix().inputs.iter().filter_map(|i| match i { Input::ToKey { key_image, .. } => Some(key_image.to_bytes()), _ => None }).collect()
}
fn seed() -> Zeroizing<[u8; 32]> {
    let mut b = [0; 32];
    OsRng.fill_bytes(&mut b);
    Zeroizing::new(b)
}
fn image(sk: Scalar) -> [u8; 32] {
    let s: DS = sk.into();
    Point::from(Point::biased_hash((G * s).compress().to_bytes()).into() * s).compress().to_bytes()
}
fn fee(tx: &Transaction) -> Result<u64> {
    match tx {
        Transaction::V2 { proofs: Some(p), .. } => Ok(p.base.fee),
        _ => anyhow::bail!("RingCT required"),
    }
}
fn b32(s: &J) -> Result<[u8; 32]> {
    hex::decode(s.as_str().context("hex")?)?.try_into().map_err(|_| anyhow::anyhow!("32 bytes"))
}
fn write_private(file: &Path, text: &str) -> Result<()> {
    use std::io::Write as _;
    use std::os::unix::fs::OpenOptionsExt;
    let tmp = file.with_extension("part");
    {
        let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
        f.write_all(text.as_bytes())?;
        f.sync_data()?;
    }
    std::fs::rename(&tmp, file)?;
    Ok(())
}

struct Wallet {
    spend: Zeroizing<Scalar>,
    view: ViewPair,
    owned: BTreeMap<[u8; 32], WalletOutput>,
    // Inputs of every carrier this wallet built. Never pruned: a built carrier may still be sent again after a restart.
    spent: BTreeSet<[u8; 32]>,
    // An output received at height h can be spent from block h+10 (a mining reward from h+60).
    maturity: BTreeMap<[u8; 32], (usize, bool)>,
    // Subaddresses 1..=subs were given out for fee payments; every scan looks for outputs to them.
    subs: u32,
    // Outputs received at those subaddresses: (transaction, output number) -> (subaddress, amount, block).
    payments: BTreeMap<([u8; 32], u64), (u32, u64, usize)>,
    network: String,
    start: usize,
    tip: usize,
    tip_hash: [u8; 32],
    state_file: PathBuf,
}
impl Wallet {
    fn open(dir: &Path, network: &str, start: usize) -> Result<Self> {
        let k: J = serde_json::from_slice(&std::fs::read(dir.join("carrier.keys.json")).context("No wallet keys here; run init first")?)?;
        let s = Scalar::read(&mut b32(&k["spend"])?.as_slice())?;
        let v = Scalar::read(&mut b32(&k["view"])?.as_slice())?;
        let d: DS = s.into();
        let mut w = Self {
            spend: Zeroizing::new(s),
            view: ViewPair::new(Point::from(G * d), Zeroizing::new(v)).map_err(|e| anyhow::anyhow!("view pair: {e:?}"))?,
            owned: BTreeMap::new(),
            spent: BTreeSet::new(),
            maturity: BTreeMap::new(),
            subs: 0,
            payments: BTreeMap::new(),
            network: network.to_string(),
            start,
            tip: 0,
            tip_hash: [0; 32],
            state_file: dir.join("carrier.state.json"),
        };
        if let Ok(text) = std::fs::read(&w.state_file) {
            let v: J = serde_json::from_slice(&text)?;
            ensure!(v["v"] == 1 && v["network"] == network && v["start"] == start as u64, "Saved wallet state is for another network or start block");
            for e in v["owned"].as_array().context("owned")? {
                let o = WalletOutput::read(&mut hex::decode(e[1].as_str().context("output")?)?.as_slice())?;
                let x: DS = w.secret(&o).into();
                ensure!(Point::from(G * x).compress().to_bytes() == o.key().compress().to_bytes(), "Saved wallet state holds a coin of another wallet");
                w.owned.insert(b32(&e[0])?, o);
            }
            for e in v["maturity"].as_array().context("maturity")? {
                w.maturity.insert(b32(&e[0])?, (e[1].as_u64().context("height")? as usize, e[2].as_bool().context("reward")?));
            }
            for e in v["spent"].as_array().context("spent")? {
                w.spent.insert(b32(e)?);
            }
            w.subs = v["subs"].as_u64().unwrap_or(0) as u32;
            for e in v["payments"].as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
                w.payments.insert(
                    (b32(&e[0])?, e[1].as_u64().context("output")?),
                    (e[2].as_u64().context("subaddress")? as u32, e[3].as_str().context("amount")?.parse()?, e[4].as_u64().context("height")? as usize),
                );
            }
            w.tip = v["tip"].as_u64().context("tip")? as usize;
            w.tip_hash = b32(&v["tipHash"])?;
        }
        Ok(w)
    }
    fn save(&self) -> Result<()> {
        let v = json!({"v":1,"network":self.network,"start":self.start,"tip":self.tip,"tipHash":hex::encode(self.tip_hash),
            "owned":self.owned.iter().map(|(k,o)|(hex::encode(k),hex::encode(o.serialize()))).collect::<Vec<_>>(),
            "maturity":self.maturity.iter().map(|(k,(h,c))|(hex::encode(k),*h,*c)).collect::<Vec<_>>(),
            "spent":self.spent.iter().map(hex::encode).collect::<Vec<_>>(),"subs":self.subs,
            "payments":self.payments.iter().map(|((t,i),(s,a,h))|json!([hex::encode(t),i,s,a.to_string(),h])).collect::<Vec<_>>()});
        write_private(&self.state_file, &v.to_string())
    }
    fn net(&self) -> Network {
        if self.network == "stagenet" { Network::Stagenet } else { Network::Mainnet }
    }
    fn address(&self) -> MoneroAddress {
        self.view.legacy_address(self.net())
    }
    // Gives out subaddress n. The count is saved first, so no scan after this misses a payment to it.
    fn subaddress(&mut self, n: u32) -> Result<MoneroAddress> {
        ensure!((1..=MAX_SUBADDRESSES).contains(&n), "Subaddress number out of range");
        if n > self.subs {
            self.subs = n;
            self.save()?;
        }
        Ok(self.view.subaddress(self.net(), SubaddressIndex::new(0, n).context("subaddress")?))
    }
    fn secret(&self, o: &WalletOutput) -> Scalar {
        let a: DS = (*self.spend).into();
        let b: DS = o.key_offset().into();
        Scalar::from(a + b)
    }
    async fn refresh(&mut self, r: &Rpc) -> Result<()> {
        guard(r, &self.network).await?;
        let tip = r.latest_block_number().await?;
        let tip_hash = r.block_by_number(tip).await?.hash();
        let first = self.start.max(1);
        let resume = self.tip >= first && self.tip <= tip && r.block_by_number(self.tip).await?.hash() == self.tip_hash;
        let (start, mut previous, mut owned, mut maturity, mut payments) = if resume {
            (self.tip + 1, self.tip_hash, self.owned.clone(), self.maturity.clone(), self.payments.clone())
        } else {
            (first, if first <= tip { r.block_by_number(first - 1).await?.hash() } else { [0u8; 32] }, BTreeMap::new(), BTreeMap::new(), BTreeMap::new())
        };
        let mut scanner = Scanner::new(self.view.clone());
        for n in 1..=self.subs {
            scanner.register_subaddress(SubaddressIndex::new(0, n).context("subaddress")?);
        }
        for h in start..=tip {
            let b = r.block_by_number(h).await?;
            ensure!(b.number() == h && b.header.previous == previous, "The chain changed during the scan; try again");
            previous = b.hash();
            let reward_txid = b.miner_transaction().hash();
            let scan = r.expand_to_scannable_block(b).await?;
            for tx in &scan.transactions {
                for i in images(tx) {
                    owned.remove(&i);
                }
            }
            // A mining reward is locked for 60 blocks; it is skipped here unless the scan runs after it unlocked.
            for o in scanner.scan(scan)?.additional_timelock_satisfied_by(tip, 0) {
                if let Some(sub) = o.subaddress() {
                    if sub.account() == 0 {
                        payments.insert((o.transaction(), o.index_in_transaction()), (sub.address(), o.commitment().amount, h));
                    }
                }
                let ki = image(self.secret(&o));
                maturity.insert(ki, (h, o.transaction() == reward_txid));
                owned.insert(ki, o);
            }
        }
        if first <= tip {
            ensure!(previous == tip_hash, "The chain changed during the scan; try again");
        }
        self.owned = owned;
        self.maturity = maturity;
        self.payments = payments;
        self.tip = tip;
        self.tip_hash = tip_hash;
        self.save()
    }
    fn mature(&self, ki: &[u8; 32]) -> bool {
        match self.maturity.get(ki) {
            Some((h, reward)) => self.tip + 1 >= h + if *reward { 60 } else { 10 },
            None => false,
        }
    }
    fn usable(&self, least: u64) -> Vec<([u8; 32], WalletOutput)> {
        let mut v: Vec<_> = self.owned.iter().filter(|(i, o)| !self.spent.contains(*i) && self.mature(i) && o.commitment().amount > least).map(|(i, o)| (*i, o.clone())).collect();
        v.sort_by_key(|(_, o)| o.commitment().amount);
        v
    }
    async fn build(&mut self, r: &Rpc, payments: Vec<(MoneroAddress, u64)>, data: Vec<Vec<u8>>, largest: bool) -> Result<Transaction> {
        self.refresh(r).await?;
        let total: u64 = payments.iter().map(|(_, a)| *a).sum();
        let usable = self.usable(total + MIN_INPUT);
        // A record rides on the smallest coin that can pay for it, so large coins stay whole for splitting.
        let none = if largest && !self.usable(MIN_INPUT).is_empty() { "No coin of this wallet is large enough to be split into that many coins; pay it a larger amount in one payment" } else { "No coin of this wallet can pay for a transaction now (coins unlock 10 blocks after they arrive)" };
        ensure!(!usable.is_empty(), none);
        let rate: FeeRate = ProvidesFeeRates::fee_rate(r, FeePriority::Unimportant, 10_000_000).await?;
        let order: Vec<_> = if largest { usable.into_iter().rev().collect() } else { usable };
        // A small coin (a fee payment, say) may not cover the network fee of the day: the next larger coin is tried.
        let mut built = None;
        let mut short = String::new();
        for (ki, out) in order {
            let decoys = OutputWithDecoys::new(&mut OsRng, r, 16, r.latest_block_number().await?, out).await?;
            match SignableTransaction::new(RctType::ClsagBulletproofPlus, seed(), vec![decoys], payments.clone(), Change::new(self.view.clone(), None), data.clone(), rate) {
                Ok(t) => {
                    built = Some((ki, t.sign(&mut OsRng, &self.spend)?));
                    break;
                }
                Err(e) => {
                    let text = format!("{e}");
                    ensure!(text.contains("not enough funds"), "{text}");
                    short = text;
                }
            }
        }
        let (ki, tx) = built.with_context(|| format!("No coin of this wallet covers the network fee now ({short})"))?;
        ensure!(tx.prefix().extra.len() <= EXTRA_LIMIT, "The record does not fit a standard transaction");
        // A network fee far above the usual one means a fee spike or a fault; nothing is signed away then.
        let most: u64 = std::env::var("MORDINALS_MAX_FEE").ok().and_then(|v| v.parse().ok()).unwrap_or(5_000_000_000);
        ensure!(fee(&tx)? <= most, "The network fee of this transaction ({}) is above the limit ({most}); nothing was sent", fee(&tx)?);
        self.spent.insert(ki);
        self.save()?;
        Ok(tx)
    }
}

fn tx_json(tx: &Transaction) -> Result<J> {
    Ok(json!({"txid":hex::encode(tx.hash()),"blob":hex::encode(tx.serialize()),"fee":fee(tx)?.to_string(),"extraBytes":tx.prefix().extra.len(),"bytes":tx.serialize().len()}))
}

async fn run(dir: &Path, op: &str, arg: Option<&str>) -> Result<J> {
    let network = std::env::var("MORDINALS_NETWORK").unwrap_or_else(|_| "offline-fakechain".into());
    let start: usize = std::env::var("MORDINALS_START").ok().and_then(|s| s.parse().ok()).unwrap_or(1);
    if op == "init" {
        let keys = dir.join("carrier.keys.json");
        if !keys.exists() {
            use std::os::unix::fs::DirBuilderExt;
            std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
            let (s, v) = (Scalar::random(&mut OsRng), Scalar::random(&mut OsRng));
            let (sb, vb): (DS, DS) = (s.into(), v.into());
            write_private(&keys, &json!({"spend":hex::encode(sb.to_bytes()),"view":hex::encode(vb.to_bytes())}).to_string())?;
        }
        return Ok(json!({"address":Wallet::open(dir, &network, start)?.address().to_string()}));
    }
    let url = std::env::var("MORDINALS_NODE").context("MORDINALS_NODE is not set")?;
    ensure!(url.starts_with("http://") || url.starts_with("https://"), "MORDINALS_NODE must be an http(s) address");
    let r = SimpleRequestTransport::new(url).await?;
    guard(&r, &network).await?;
    if op == "publish" {
        let b = hex::decode(arg.context("blob")?)?;
        ensure!(b.len() < 16384, "Transaction too large");
        let mut cursor = b.as_slice();
        let tx = Transaction::read(&mut cursor)?;
        ensure!(cursor.is_empty() && tx.serialize() == b, "Not a canonical transaction");
        r.publish_transaction(&tx).await?;
        return Ok(json!({"txid":hex::encode(tx.hash())}));
    }
    let mut w = Wallet::open(dir, &network, start)?;
    match op {
        "status" => {
            w.refresh(&r).await?;
            let coins = w.usable(MIN_INPUT);
            let balance: u128 = w.owned.iter().filter(|(i, _)| !w.spent.contains(*i)).map(|(_, o)| u128::from(o.commitment().amount)).sum();
            let payments: Vec<J> = w.payments.iter().map(|((t, _), (s, a, h))| json!({"index":s,"amount":a.to_string(),"txid":hex::encode(t),"height":h})).collect();
            Ok(json!({"address":w.address().to_string(),"tip":w.tip,"balance":balance.to_string(),"coins":w.owned.len(),"ready":coins.len(),"subaddresses":w.subs,"payments":payments}))
        }
        "address" => {
            let n: u32 = arg.context("subaddress number")?.parse()?;
            Ok(json!({"address":w.subaddress(n)?.to_string(),"index":n}))
        }
        "carry" => {
            let record = hex::decode(arg.context("record")?)?;
            let me = w.address();
            let tx = w.build(&r, vec![(me, SELF_PAYMENT)], parts(&record)?, false).await?;
            tx_json(&tx)
        }
        "split" => {
            let n: usize = arg.context("count")?.parse()?;
            ensure!((2..=14).contains(&n), "2 to 14 coins per transaction");
            let me = w.address();
            let tx = w.build(&r, vec![(me, SPLIT_COIN); n], vec![], true).await?;
            tx_json(&tx)
        }
        other => anyhow::bail!("Unknown operation {other}"),
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let a: Vec<String> = std::env::args().collect();
    let out = if a.len() < 3 {
        json!({"error":"usage: mordinals-carrier <state dir> <init|status|carry|split|publish|address> [argument]"})
    } else {
        match run(Path::new(&a[1]), &a[2], a.get(3).map(|s| s.as_str())).await {
            Ok(result) => json!({"result":result}),
            Err(e) => json!({"error":format!("{e:#}")}),
        }
    };
    let failed = out.get("error").is_some();
    println!("{out}");
    std::process::exit(if failed { 1 } else { 0 });
}
