var util = require('util');
var fs = require('fs');
var net = require('net');
var events = require('events');
var path = require('path');
var pipe = require('pipe');
var _  = require('underscore');
var fixutil = require('./fixutils.js');
var { FIXClient } = require("./FIXClient.js");

//TODO
//Improve 'error' events. If sender/target exist, add them
//Clean up direct use of msg fields. Prefer the use of sender/target from context rather 
//than trying to get fields directly (or do the opposite?)
//If no logon is established x seconds after connection, kill connection and notify client


exports.FIXClient = FIXClient;
exports.fixutil = fixutil;

//-----------------------------Expose server API-----------------------------
exports.createServer = function(opt, func) {
    var server = new Server(opt, func);
    return server;
};

//TODO: handle error event, for example, when the listening port is already being used
function Server(opt, callback) {
     events.EventEmitter.call(this);

     this.sessions = {};
     this.port = null;

     var self = this;

     this.server = net.createServer(function(stream) {

        stream.setTimeout(2 * 60 * 1000);//if no traffic for two minutes, kill connection!

        this.senderCompID = null;
        this.targetCompID = null;
        this.fixVersion = null;
        
        stream.p = null;
        var SessionEmitterObj = function(){
            events.EventEmitter.call(this);
            this.write = function (data) { stream.p.pushOutgoing({ data: data, type: 'data' }); };
            this.end = function () { stream.end(); };
        }
        util.inherits(SessionEmitterObj,events.EventEmitter);

        stream.sessionEmitter = new SessionEmitterObj();

        stream.sessionEmitter.emit('connect', stream.remoteAddress, self.port, 'acceptor');
        
        stream.p = pipe.makePipe(stream);
        stream.p.addHandler(require('./handlers/fixFrameDecoder.js').newFixFrameDecoder());
        stream.p.addHandler(require('./handlers/outMsgEvtInterceptor.js').newOutMsgEvtInterceptor( stream ));
        stream.p.addHandler(require('./handlers/sessionProcessor.js').newSessionProcessor(true, opt));
        stream.p.addHandler(require('./handlers/inMsgEvtInterceptor.js').newInMsgEvtInterceptor( stream ));

        stream.on('data', function (data) { stream.p.pushIncoming({ data: data, type: 'data' }); });
        stream.on('timeout', function(){ stream.end(); });

        //stream.on('connect', function(){ session.sessionEmitter.emit('connect');})
        if (callback)
        	callback(stream.sessionEmitter);
     });
     
     self.server.on('error', function(err){ self.emit('error', err); });

     this.listen = function(port, host, callback) {
        self.port = port;
        self.server.listen(port, host, callback);
    };
     this.write = function(targetCompID, data) { self.sessions[targetCompID].write({data:data, type:'data'}); };
     this.logoff = function(targetCompID, logoffReason) { self.sessions[targetCompID].write({data:{35:5, 58:logoffReason}, type:'data'}); };
     this.kill = function(targetCompID, reason){ self.sessions[targetCompID].end(); };
}
util.inherits(Server, events.EventEmitter);

//-----------------------------Expose client API-----------------------------
exports.createClient = function(fixVersion, senderCompID, targetCompID, opt) {
    return new Client(fixVersion, senderCompID, targetCompID, opt);
};

function Client(fixVersion, senderCompID, targetCompID, opt) {
    events.EventEmitter.call(this);
    
    var stream = null;
    this.port = null;
    this.host = null;
    var self = this; 
    var fixFrameDecoder = require('./handlers/fixFrameDecoder.js').newFixFrameDecoder();
    var outMsgEvtInterceptor = require('./handlers/outMsgEvtInterceptor.js').newOutMsgEvtInterceptor({ 'sessionEmitter': self })
    var sessionProcessor = require('./handlers/sessionProcessor.js').newSessionProcessor(false, opt);
    var inMsgEvtInterceptor = require('./handlers/inMsgEvtInterceptor.js').newInMsgEvtInterceptor({ 'sessionEmitter': self });

    //--CLIENT METHODS--
    this.write = function(data) { self.p.pushOutgoing({data:data, type:'data'}); };
    this.connect = function(port, host, callback){
    
        //self.p.state.session['remoteAddress'] = host;
        self.stream = net.createConnection(port, host, callback);

        self.p = pipe.makePipe(self.stream);
        self.p.addHandler(fixFrameDecoder);
        self.p.addHandler(outMsgEvtInterceptor);
        self.p.addHandler(sessionProcessor);
        self.p.addHandler(inMsgEvtInterceptor);
        
        self.stream.on('connect', function () { self.emit('connect', { port: self.host, port: self.port}); });
        self.stream.on('logon', function (senderId, targetId) { self.emit('logon', { senderId: senderId, targetId: targetId }); });
        self.stream.on('logoff', function (senderId, targetId) { self.emit('logoff', { senderId: senderId, targetId: targetId }); });
        self.stream.on('data', function (data) { self.p.pushIncoming({ data: data, type: 'data' }); });
        self.stream.on('end', function () { self.emit('end', { senderId: senderCompID, targetId: targetCompID }); self.stream.destroy(); });
        self.stream.on('close', function () {
        	self.emit('close', { senderId: senderCompID, targetId: targetCompID });
        	sessionProcessor.isLoggedIn = false;
        });
        self.stream.on('error', function (err) {self.emit('error', err); });
    }
    this.reconnect = function () {
    	self.connect(self.port, self.host);
    }
    this.logon = function (logonmsg) {
        logonmsg = _.isUndefined(logonmsg)? {'8':fixVersion, '49':senderCompID, '56': targetCompID, '35': 'A', '90': '0', '108': '10'} : logonmsg;
        self.p.pushOutgoing({data:logonmsg, type:'data'});
    }
    this.connectAndLogon = function(port, host){
        self.port = port;
        self.host = host;
        self.connect(port, host);
        self.on('connect', function(){ self.logon(); });
    }
    this.logoff = function (logoffReason) {
    	logoffmsg = { '8': fixVersion, '49': senderCompID, '56': targetCompID, '35': 5, '58': logoffReason };
    	self.p.pushOutgoing({ data: logoffmsg, type: 'data' })
    };
}
util.inherits(Client, events.EventEmitter);

