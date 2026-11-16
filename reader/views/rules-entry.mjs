// What the pages use from the rule library. build.mjs bundles this file into rules.js.
export {OP,RULES,MAX_RECORD,NO_COLLECTION,MAX_NAME,MAX_EDITIONS,heldUntil,encodeBody,decodeRecord,recordId,codeOf,amounts,splitOf,renderText,nftLabel,attachSignature,formatXmr,parseXmr,canonical} from '../../rules/lib/records.mjs';
export {parseTxKey,provePayments} from '../../rules/lib/payment.mjs';
export {hex,unhex} from '../../rules/lib/monero.mjs';
// For the pages that explain claiming by burning: they work out the burn address and the text themselves.
export {burnAddress,CLAIM_PREFIX} from '../../rules/lib/burn.mjs';
// and the fee wallet and each Mordinal's fee address.
export {FEE_WALLET,FEE_SAFE,feeWallet,feeAddressOf} from '../../rules/lib/burn-fee.mjs';
