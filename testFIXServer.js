var fix = require('./fix.js');
var {FIXServer} = require("./FIXServer.js");

var server = new FIXServer({})
server.dataIn$.subscribe((x)=>{console.log(x)})
server.listen(1234, "localhost")
// client.connectAndLogon(1234,'localhost');
// fix.createServer({},function(session){
//     console.log("EVENT connect");
//     session.on("end", function(sender,target){ console.log("EVENT end"); });
//     session.on("logon", function(sender, target){ console.log("EVENT logon: "+ sender + ", " + target); });
//     session.on("incomingmsg", function(msg){ console.log("EVENT incomingmsg: ", msg); });
//     session.on("outgoingmsg", function(msg){ console.log("EVENT outgoingmsg: ", msg); });

// }).listen(1234, "localhost");

