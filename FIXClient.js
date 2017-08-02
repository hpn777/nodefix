const { Observable } = require('rx')
var net = require('net');
var events = require('events');
var fixutil = require('./fixutils.js');
var {FrameDecoder} = require('./handlers/FrameDecoder')
var {FIXSession} = require('./handlers/FIXSession')

exports.fixutil = fixutil;

exports.FIXClient = function(fixVersion, senderCompID, targetCompID, opt) {
    var self = this
    var HOST
    var PORT
    const fixSession = new FIXSession(this, false, opt)
    this.getSeqNums = () => { return {'incomingSeqNum': 1, 'outgoingSeqNum': 1 } }
    
    //--CLIENT METHODS--
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
        
        self.connect$ = Observable.create((observer) => {
		    self.connection.on('connect', function (evt) {
			    observer.onNext(evt)
            })
        })

        self.logon$ = Observable.create((observer) => {
		    self.connection.on('logon', function (evt) {
			    observer.onNext(evt)
            })
        })

        self.logoff$ = Observable.create((observer) => {
		    self.connection.on('logoff', function (evt) {
			    observer.onNext(evt)
            })
        })

        self.data$ = new FrameDecoder(Observable.create((observer) => {
		    self.connection.on('data', function (evt) {
			    observer.onNext(evt)
            })
        }))

        self.data$
            .map((msg)=>{ return fixSession.decode(msg)})
            .subscribe((response)=>{console.log('RESPONSE',response)})

        self.end$ = Observable.create((observer) => {
		    self.connection.on('end', function (evt) {
			    observer.onNext(evt)
            })
        })

        self.close$ = Observable.create((observer) => {
		    self.connection.on('close', function (evt) {
			    observer.onNext(evt)
            })
        })

        self.error$ = Observable.create((observer) => {
		    self.connection.on('error', function (evt) {
			    observer.onNext(evt)
            })
        })
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