const fs=require('fs');const {generateEmailVerifierInputs}=require('@zk-email/zkemail-nr');
(async()=>{const eml=fs.readFileSync(process.argv[2]);
const inp=await generateEmailVerifierInputs(eml,{maxHeadersLength:+process.argv[4]||512,maxBodyLength:+process.argv[5]||1024});
fs.writeFileSync(process.argv[3],JSON.stringify(inp));console.log('inputs keys',Object.keys(inp),'header len',inp.header.len,'body len',inp.body&&inp.body.len);})().catch(e=>{console.error(e);process.exit(1)});
