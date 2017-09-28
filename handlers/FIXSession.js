var util = require('util');
var fs = require('fs');
var readline = require('readline')
const { Observable } = require('rx');
var storage = require('node-persist');
var fixutil = require('../fixutils.js');
var _  = require('underscore');
var events = require('events');
var sessions = {}

storage.initSync()

exports.FIXSession = function(fixClient, isAcceptor, options) {
    var self = this;
    var isAcceptor = isAcceptor;
    var fixVersion = options.fixVersion;
    var clearStorage = options.clearStorage
    var senderCompID = options.senderCompID;
    var senderSubID = options.senderSubID;
    var targetCompID = options.targetCompID;
    var key = options.senderCompID + '-' + options.targetCompID

    var isDuplicateFunc = _.isUndefined(options.isDuplicateFunc)? function (senderId, targetId) {
        var key = senderId + '-' + targetId
        return sessions[key] ? sessions[key].isLoggedIn : false
    } : options.isDuplicateFunc;

    var isAuthenticFunc = _.isUndefined(options.isAuthenticFunc)? function () {return true;} : options.isAuthenticFunc;

    var retriveSession = _.isUndefined(options.retriveSession)? function (senderId, targetId) {
        key = senderId + '-' + targetId
        var savedSession = storage.getItemSync(key)

        sessions[key] = savedSession || {'incomingSeqNum': 1, 'outgoingSeqNum': 1}
        sessions[key].isLoggedIn = false //default is always logged out
        return sessions[key]
    } : options.retriveSession;
    
    var saveSession = _.debounce(()=>{
        storage.setItemSync(key, session)
    }, 100)

    var defaultHeartbeatSeconds = _.isUndefined(options.defaultHeartbeatSeconds)? "10" : options.defaultHeartbeatSeconds;

    var sendHeartbeats = _.isUndefined(options.sendHeartbeats)? true : options.sendHeartbeats;
    var expectHeartbeats = _.isUndefined(options.expectHeartbeats)? true : options.expectHeartbeats ;
    var respondToLogon = _.isUndefined(options.respondToLogon)? true : options.respondToLogon;
    var resetSeqNumOnReconect = _.isUndefined(options.resetSeqNumOnReconect) ? true : options.resetSeqNumOnReconect;

    var heartbeatIntervalID;
    var timeOfLastIncoming = new Date().getTime();
    var timeOfLastOutgoing = new Date().getTime();
    var testRequestID = 1;
    
    var session = {'incomingSeqNum': 1, 'outgoingSeqNum': 1}
    var isResendRequested = false;
    var isLogoutRequested = false;

    var file = null;
    var fileLogging = _.isUndefined(options.fileLogging) ? true : options.fileLogging

	this.decode = function (raw) {
        timeOfLastIncoming = new Date().getTime();
        
        var fix = fixutil.convertToMap(raw);

        var msgType = fix['35'];

        //==Confirm first msg is logon==
        if (!session.isLoggedIn && msgType !== 'A') {
            var error = '[ERROR] First message must be logon:' + raw;
            throw new Error(error)
        }

        //==Process logon 
        else if (!session.isLoggedIn && msgType === 'A') {            
            //==Process acceptor specific logic (Server)
            if (isAcceptor) {
                fixVersion = fix['8'];
                //incoming sender and target are swapped because we want sender/comp
                //from our perspective, not the counter party's
                senderCompID = fix['56']
                senderSubID = fix['50']
                targetCompID = fix['49']
                //==Check duplicate connections
                if (isDuplicateFunc(senderCompID, targetCompID)) {
                    var error = '[ERROR] Session already logged in:' + raw;
                    throw new Error(error)
                }

                //==Authenticate connection
                if (!isAuthenticFunc(fix, fixClient.connection.remoteAddress)) {
                    var error = '[ERROR] Session not authentic:' + raw;
                    throw new Error(error)
                }
                
                //==Sync sequence numbers from data store
                if(resetSeqNumOnReconect)
                    session =  {'incomingSeqNum': 1, 'outgoingSeqNum': 1}
                else 
                    session = retriveSession(senderCompID, targetCompID)
            } //End Process acceptor specific logic==


            var heartbeatInMilliSecondsStr = _.isUndefined(fix[108] )? defaultHeartbeatSeconds : fix[108];
            var heartbeatInMilliSeconds = parseInt(heartbeatInMilliSecondsStr, 10) * 1000;
            
        	//==Set heartbeat mechanism
            heartbeatIntervalID = setInterval(function () {
            	var currentTime = new Date().getTime();

            	//==send heartbeats
            	if (currentTime - timeOfLastOutgoing > heartbeatInMilliSeconds && sendHeartbeats) {
            		self.send({
            			'35': '0'
            		}); //heartbeat
            	}

            	//==ask counter party to wake up
            	if (currentTime - timeOfLastIncoming > (heartbeatInMilliSeconds * 1.5) && expectHeartbeats) {
            		self.send({
            			'35': '1',
            			'112': testRequestID++
            		}); //test req id
            	}

            	//==counter party might be dead, kill connection
            	if (currentTime - timeOfLastIncoming > heartbeatInMilliSeconds * 2 && expectHeartbeats) {
            		var error = targetCompID + '[ERROR] No heartbeat from counter party in milliseconds ' + heartbeatInMilliSeconds * 1.5;
                    fixClient.connection.emit('error', error)
                    //throw new Error(error)
            	}

            }, heartbeatInMilliSeconds / 2);

            fixClient.connection.on('close', function () {
                clearInterval(heartbeatIntervalID);
            });

            //==Logon successful
            session.isLoggedIn = true;
            self.emit('logon', targetCompID);
            //==Logon ack (acceptor)
            if (isAcceptor && respondToLogon) {
                self.send(_.extend({}, fix));
            }

        } // End Process logon==

        if(msgType !== '4'){
            //==Check sequence numbers
            var msgSeqNum = Number(fix['34'])
            //expected sequence number
            if (msgSeqNum === session.incomingSeqNum) {
                
                session.incomingSeqNum++;
                isResendRequested = false;
            }
            //less than expected
            else if (msgSeqNum < session.incomingSeqNum) {
                //ignore posdup
                if (fix['43'] === 'Y') {
                    return Observable.never()
                }
                //if not posdup, error
                else {
                    self.logoff('sequence number lower than expected')

                    var error = '[ERROR] Incoming sequence number ('+msgSeqNum+') lower than expected (' + session.incomingSeqNum+ ') : ' + raw;
                    throw new Error(error)
                }
            }
            //greater than expected
            else {
                self.requestResend()
            }
        }

        switch(msgType){
            case '1'://==Process test request
                var testReqID = fix['112'];
                self.send({
                    '35': '0',
                    '112': testReqID
                });
                break;
            case '2'://==Process resend-request
                self.resendMessages(fix['7'], fix['16']);
                break;
            case '4':
                //==Process sequence-reset
                var resetseqno = Number(fix['36'])
                if(resetseqno !== NaN){
                    resetseqno++
                    if (resetseqno >= session.incomingSeqNum) {
                        session.incomingSeqNum = resetseqno
                    } else {
                        var error = '[ERROR] Seq-reset may not decrement sequence numbers: ' + raw;
                        throw new Error(error)
                    }
                } else {
                    var error = '[ERROR] Seq-reset has invalid sequence numbers: ' + raw;
                    throw new Error(error)
                }
                break;
            case '5'://==Process logout
                if (!isLogoutRequested)
                    self.send(_.extend({}, fix));

                setImmediate(()=>{fixClient.connection.destroy()})
                self.resetFIXSession(false)
                self.emit('logoff', senderCompID, targetCompID);
                break;
        }

        saveSession()
		return fix
    }

    this.logon = function (logonmsg) {
        logonmsg = !logonmsg ? { '35': 'A', '90': '0', '108': '10'} : logonmsg;
        
        if(options.userID && options.password){
            logonmsg['553'] = options.userID
            logonmsg['554'] = options.password
            logonmsg['95'] = options.password.length
            logonmsg['96'] = options.password
        }
            
        //==Sync sequence numbers from data store
        if (resetSeqNumOnReconect) 
            session = {'incomingSeqNum': 1, 'outgoingSeqNum': 1}
        else
            session = retriveSession(senderCompID, targetCompID)

        this.send(logonmsg)
    }

    this.logoff = function (logoffReason) {
    	logoffmsg = { '35': 5, '58': logoffReason || '' };
        this.send(logoffmsg)
        isLogoutRequested = true
    }
        
    this.logToFile = function(raw){
        if (file === null) {
            this.logfilename = './traffic/' + senderCompID + '_' + targetCompID + '.log';
            
            try{
        	    fs.mkdirSync('./traffic', { 'flags': 'a+' })
            }
            catch(ex){}
            
            try{
                if(resetSeqNumOnReconect)
                    fs.unlinkSync(this.logfilename);
            }
            catch(ex){}

            file = fs.createWriteStream(this.logfilename, { 'flags': 'a', 'mode': 0666 });
            file.on('error', function (error) { fixClient.connection.emit('error', error) });
            fixClient.connection.on('close', function () {
                file.close()
            });
        }

		file.write(raw + '\n');
    }

    this.resetFIXSession = function(clearHistory){
        session = retriveSession(senderCompID, targetCompID)
        session.incomingSeqNum = 1
        session.isLoggedIn = false
       
        try{ 
            if(clearHistory){
                session.outgoingSeqNum = 1
                fs.unlinkSync(this.logfilename)
            }
        }
        catch(ex){}
        saveSession()
    }

    this.resendMessages = function (BeginSeqNo, EndSeqNo) {
    	if (this.logfilename) {
            BeginSeqNo = BeginSeqNo ? Number(BeginSeqNo) : 0
    		EndSeqNo = Number(EndSeqNo) ? Number(EndSeqNo) : session.outgoingSeqNum
    		var reader = fs.createReadStream(this.logfilename, {
    			'flags': 'r',
    			'encoding': 'binary',
    			'mode': 0666,
    			//'bufferSize': 4 * 1024
            })
            var lineReader = readline.createInterface({
                input: reader
            })

            lineReader.on('line', (line) => {
                var _fix = fixutil.convertToMap(line);
    			var _msgType = _fix[35];
                var _seqNo = Number(_fix[34]);
                if((BeginSeqNo <= _seqNo) && ( EndSeqNo >= _seqNo)){
                    if (_.include(['A', '5', '2', '0', '1', '4'], _msgType)) {
                        //send seq-reset with gap-fill Y
                        self.send({
                            '35': '4',
                            '123': 'Y',
                            '36': _seqNo
                        }, true);
                    } else {
                        //send msg w/ posdup Y
                        self.send(_.extend(_fix, {
                            '43': 'Y',
                            '36': _seqNo
                        }), true);
                    }
                }
                else if(EndSeqNo < _seqNo){
                    lineReader.removeAllListeners('line')
                    reader.close()
                }
            })
    	}
    }

    this.requestResend = function(){
        if (isResendRequested === false) {
            isResendRequested = true;
            //send resend-request
            self.send({
                '35': '2',
                '7': session.incomingSeqNum,
                '16': '0'
            });
        }
    }

    this.send = function(msg, replay){
        var outgoingSeqNum = replay ? 1 : session.outgoingSeqNum
        var outmsg = fixutil.convertToFIX(msg, fixVersion,  fixutil.getUTCTimeStamp(),
            senderCompID,  targetCompID,  outgoingSeqNum, senderSubID);
        
        
        self.emit('dataOut', msg)
        self.emit('fixOut', outmsg)

        fixClient.connection.write(outmsg);
        if(!replay){
            timeOfLastOutgoing = new Date().getTime();
            session.outgoingSeqNum++
            self.logToFile(outmsg)
            saveSession()
        }
    }
}

util.inherits(exports.FIXSession, events.EventEmitter);
