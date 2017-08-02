const { Observable } = require('rx')
var net = require('net');
var fixutil = require('./fixutils.js');
var {FrameDecoder} = require('./handlers/FrameDecoder')
var {FIXSession} = require('./handlers/FIXSession')

exports.fixutil = fixutil;

exports.FIXClient = function(fixVersion, senderCompID, targetCompID, opt) {
    var self = this
    var HOST
    var PORT
    const fixSession = new FIXSession(this, false, opt)
    const frameDecoder = new FrameDecoder()
    
    this.send = function(fix) { 
        if(self.connection){
            fixSession.send(fix)
        } 
    }
    
    this.connect = function(port, host, callback){
        HOST = host
        PORT = port
        //self.p.state.session['remoteAddress'] = host;
        self.connection = net.createConnection(port, host, callback);
        
        self.connect$ = Observable.fromEvent(self.connection, 'connect');
        self.logon$ = Observable.fromEvent(fixSession, 'logon');
        self.logoff$ = Observable.fromEvent(fixSession, 'logoff');
        self.rawIn$ = Observable.fromEvent(self.connection, 'data');
        self.end$ = Observable.fromEvent(self.connection, 'end');
        self.close$ = Observable.fromEvent(self.connection, 'close');
        self.error$ = Observable.fromEvent(self.connection, 'error');
        self.dataOut$ = Observable.fromEvent(fixSession, 'dataOut');
        self.fixOut$ = Observable.fromEvent(fixSession, 'fixOut');
        
        self.fixIn$ = self.rawIn$
            .flatMap((raw) => { return frameDecoder.decode(raw)})
        self.dataIn$ = self.fixIn$
            .map((msg) => { return fixSession.decode(msg)})
            .catch((ex)=>{
                console.log(ex)
                self.connection.emit('error', ex)
                return Observable.empty()}
            )
            .share()
        
        self.dataIn$.subscribe()
    }
    
    this.reconnect = function () {
    	self.connect(PORT, HOST);
    }
    
    this.logon = function (logonmsg) {
        logonmsg = !logonmsg ? {'8':fixVersion, '49':senderCompID, '56': targetCompID, '35': 'A', '90': '0', '108': '10'} : logonmsg;
        self.send(logonmsg)
    }
    
    this.connectAndLogon = function(port, host){
        PORT = port;
        HOST = host;
        self.connect(port, host);
        self.connect$.subscribe(()=>{
            self.logon()
        })
    }

    this.logoff = function (logoffReason) {
    	logoffmsg = { '8': fixVersion, '49': senderCompID, '56': targetCompID, '35': 5, '58': logoffReason };
    	self.send(logoffmsg)
    }

    return this
}