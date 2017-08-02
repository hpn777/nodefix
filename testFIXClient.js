//var fix = require("./fix.js");

// var session = fix.createClient("FIX.4.2", "initiator", "acceptor", 1234, "localhost");
// session.connectAndLogon(1234,'localhost');
// /*session.getMessages(function(err, msg){
//     if(err){
//         console.log('Err from data store: '+err);     
//     }
//     else{
//         console.log('Msg from data store: '+JSON.stringify(msg)); 
//     }
// });*/
// session.on("connect", function(){ console.log("EVENT connect"); });
// session.on("end", function(){ console.log("EVENT end"); });
// session.on("logon", function(sender, target){ console.log("EVENT logon: "+ sender + ", " + target); });
// session.on("logoff", function(sender, target){ console.log("EVENT logoff: "+ sender + ", " + target); });
// session.on("incomingmsg", function(msg){ console.log("EVENT incomingmsg: ", msg) });
// session.on("outgoingmsg", function(msg){ console.log("EVENT outgoingmsg: ", msg) });

var {FIXClient} = require("./FIXClient.js");

var client = new FIXClient("FIX.4.2", "initiator", "acceptor", 1234, "localhost")
client.connectAndLogon(1234,'localhost');