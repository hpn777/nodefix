var fix = require('./fix.js');

fix.createServer({},function(session){
    console.log("EVENT connect");
    session.on("end", function(sender,target){ console.log("EVENT end"); });
    session.on("logon", function(sender, target){ console.log("EVENT logon: "+ sender + ", " + target); });
    session.on("incomingmsg", function(msg){ console.log("EVENT incomingmsg: ", msg); });
    session.on("outgoingmsg", function(msg){ console.log("EVENT outgoingmsg: ", msg); });

}).listen(1234, "localhost");

