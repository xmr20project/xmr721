// Feeds scanned mainnet transactions, in chain order, to the unmodified original
// Mordinals index (inscriptions_container) and writes what it decided.
// Usage: replay OUT.jsonl PART.bin [PART.bin ...]
#include "cryptonote_core/inscriptions_container.h"
#include "cryptonote_basic/cryptonote_format_utils.h"
#include "string_tools.h"
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <vector>
using namespace cryptonote;
static void require(bool ok,const std::string& why){if(!ok)throw std::runtime_error(why);}
static std::string hex(const void* p,size_t n){return epee::string_tools::buff_to_hex_nodelimer(std::string(reinterpret_cast<const char*>(p),n));}
static bool rd(FILE* f,void* p,size_t n){return fread(p,1,n,f)==n;}
template<class T> static T le(FILE* f){T v=0;unsigned char b[8];require(rd(f,b,sizeof(T)),"short frame");for(size_t i=0;i<sizeof(T);i++)v|=T(b[i])<<(8*i);return v;}
int main(int argc,char** argv){try{
 require(argc>=3,"usage: replay OUT.jsonl PART.bin...");
 std::ofstream out(argv[1]);inscriptions_container index;
 std::vector<uint64_t> owner_out;std::vector<std::string> owner_key;
 uint64_t last_height=0,last_pos=0,frames=0,registered=0,updated=0,none=0;bool any=false,fatal=false;
 for(int a=2;a<argc;a++){
  FILE* f=fopen(argv[a],"rb");require(f,"cannot open part");bool ended=false;int c;
  while((c=fgetc(f))!=EOF){
   require(!ended,"data after end frame");
   if(c=='E'){uint32_t n=le<uint32_t>(f);std::string j(n,0);require(rd(f,&j[0],n),"short end frame");out<<"{\"t\":\"part\",\"summary\":"<<j<<"}\n";ended=true;continue;}
   require(c=='T',"unknown frame");
   uint64_t tx_id=le<uint64_t>(f),height=le<uint64_t>(f);uint32_t pos=le<uint32_t>(f);uint8_t flags=le<uint8_t>(f);uint32_t n_outs=le<uint32_t>(f);
   std::vector<uint64_t> outs(n_outs);for(auto& o:outs)o=le<uint64_t>(f);
   uint8_t has_ph=le<uint8_t>(f);crypto::hash ph;require(rd(f,&ph,32),"short hash");
   uint32_t n=le<uint32_t>(f);std::string blob(n,0);require(rd(f,&blob[0],n),"short blob");
   require(!any||height>last_height||(height==last_height&&pos>last_pos),"frames out of chain order");any=true;last_height=height;last_pos=pos;
   require(has_ph==1&&n_outs>=1,"missing prunable hash or outputs");
   transaction tx;require(parse_and_validate_tx_base_from_blob(blob,tx),"transaction parse");
   require(tx.version==2&&tx.vout.size()==n_outs,"unexpected transaction shape");
   crypto::hash h=get_pruned_transaction_hash(tx,ph);tx.set_hash(h);
   crypto::public_key key;require(get_output_public_key(tx.vout[0],key),"output key");
   uint64_t c0=index.get_inscriptions_count(),e0=index.get_events_count();
   bool r=index.on_push_transaction(tx,height,outs);
   index.set_block_height(height);if(index.get_block_height()==0)fatal=true;
   uint64_t c1=index.get_inscriptions_count(),e1=index.get_events_count();
   const char* result="none";int64_t ins=-1;
   if(c1==c0+1){require(e1==e0,"both changed");result="registered";ins=c0;owner_out.push_back(outs[0]);owner_key.push_back(hex(&key,32));registered++;}
   else if(e1==e0+1){require(c1==c0,"both changed");std::vector<inscription_event> ev;index.get_events(e0,1,ev);require(ev.size()==1,"event read");ins=boost::get<update_event>(ev[0]).inscription_id;result="updated";owner_out[ins]=outs[0];owner_key[ins]=hex(&key,32);updated++;}
   else{require(c1==c0&&e1==e0,"unexpected change");none++;}
   if(ins>=0){inscription_info q;require(index.get_inscription_by_global_out_index(outs[0],q)&&q.index==uint64_t(ins),"output 0 not mapped to the inscription");}
   out<<"{\"t\":\"tx\",\"txId\":"<<tx_id<<",\"height\":"<<height<<",\"pos\":"<<pos<<",\"flags\":"<<int(flags)<<",\"hash\":\""<<hex(&h,32)<<"\",\"pushReturned\":"<<(r?"true":"false")<<",\"result\":\""<<result<<"\",\"inscription\":"<<ins<<",\"out0\":"<<outs[0]<<",\"key0\":\""<<hex(&key,32)<<"\",\"fee\":"<<get_tx_fee(tx)<<"}\n";
   frames++;
  }
  require(ended,"part has no end frame");fclose(f);
 }
 uint64_t count=index.get_inscriptions_count();require(count==owner_out.size(),"count mismatch");
 for(uint64_t i=0;i<count;i++){
  inscription_info x;require(index.get_inscription_by_index(i,x)&&x.index==i,"read inscription");
  inscription_info q;require(index.get_inscription_by_global_out_index(owner_out[i],q)&&q.index==i,"owner output not mapped");
  crypto::hash mh=crypto::cn_fast_hash(x.current_metadata.data(),x.current_metadata.size());
  out<<"{\"t\":\"ins\",\"index\":"<<i<<",\"imgHash\":\""<<hex(&x.img_data_hash,32)<<"\",\"imgSize\":"<<x.img_data.size()<<",\"height\":"<<x.block_height<<",\"storedGlobalOut\":"<<x.global_out_index<<",\"ownerOut\":"<<owner_out[i]<<",\"ownerKey\":\""<<owner_key[i]<<"\",\"metaSize\":"<<x.current_metadata.size()<<",\"metaHash\":\""<<hex(&mh,32)<<"\",\"history\":[";
  for(size_t k=0;k<x.history.size();k++){if(k)out<<',';out<<"{\"tx\":\""<<hex(&x.history[k].tx_id,32)<<"\",\"g\":"<<x.history[k].global_index<<",\"metaSize\":"<<x.history[k].meta_data.size()<<"}";}
  out<<"]}\n";
 }
 out<<"{\"t\":\"end\",\"frames\":"<<frames<<",\"registered\":"<<registered<<",\"updated\":"<<updated<<",\"none\":"<<none<<",\"inscriptions\":"<<count<<",\"events\":"<<index.get_events_count()<<",\"fatalErrorFlag\":"<<(fatal?"true":"false")<<",\"lastHeight\":"<<last_height<<"}\n";
 out.close();require(bool(out),"write failed");
 std::cerr<<"frames "<<frames<<" registered "<<registered<<" updated "<<updated<<" none "<<none<<" fatal "<<fatal<<"\n";return 0;
 }catch(const std::exception& e){std::cerr<<"FAIL "<<e.what()<<"\n";return 1;}}
