const { Observable, Subject } = require('rx')
var net = require('net');
var fixutil = require('./fixutils.js');
var {FrameDecoder} = require('./handlers/FrameDecoder')
var {FIXSession} = require('./handlers/FIXSession')

exports.fixutil = fixutil;

exports.FIXServer = function(opt) {
    var self = this
    var HOST
    var PORT
    
    self.connect$ = new Subject
    self.logon$ = new Subject
    self.logoff$ = new Subject
    self.fixIn$ = new Subject
    self.dataIn$ = new Subject
    self.end$ = new Subject
    self.close$ = new Subject
    self.error$ = new Subject

    var server = net.createServer(function(connection) {
        var sessionHolder = {}
        const frameDecoder = new FrameDecoder()
        const fixSession = new FIXSession(sessionHolder, true, opt)
        var senderId;

        sessionHolder.connection = connection

        var logon$ = Observable.fromEvent(fixSession, 'logon')
        logon$.subscribe(self.logon$)

        var logoff$ = Observable.fromEvent(fixSession, 'logoff')
        logoff$.subscribe(self.logoff$)

        var end$ = Observable.fromEvent(connection, 'end')
            .map((x)=>{ return senderId })
        end$.subscribe(self.end$)

        var close$ = Observable.fromEvent(connection, 'close')
            .map((x)=>{ return senderId })
        close$.subscribe(self.close$)

        var error$ = Observable.fromEvent(connection, 'error')
            .map((x)=>{ return { error: x, senderId: senderId }})
        error$.subscribe(self.error$)
        
        var rawIn$ = Observable.fromEvent(connection, 'data')
        var fixIn$ = rawIn$
            .flatMap((raw) => { return frameDecoder.decode(raw)})
        fixIn$.subscribe(self.fixIn$)

        var dataIn$ = fixIn$
            .map((msg) => {
                return {msg: fixSession.decode(msg), senderId: senderId}
            })
            .catch((ex)=>{
                console.log(ex)
                connection.emit('error', ex)
                return Observable.empty()}
            )
            .share()
        dataIn$.subscribe(self.dataIn$)

        logon$.subscribe((x) => {senderId = x})
    })

    this.listen = function(port, host, callback) {
        PORT = port
        HOST = host
        server.listen(port, host, callback);
    }

    return this
}