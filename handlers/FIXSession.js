var util = require('util');
var fs = require('fs');
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
    
    var saveSession = function(){
        storage.setItemSync(key, session)
    }

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
            fixVersion = fix['8'];
            //incoming sender and target are swapped because we want sender/comp
            //from our perspective, not the counter party's
            senderCompID = fix['56']
            senderSubID = fix['50']
            targetCompID = fix['49']
            
            //==Process acceptor specific logic (Server)
            if (isAcceptor) {
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
                    session = retriveSession()
            } //End Process acceptor specific logic==


            var heartbeatInMilliSecondsStr = _.isUndefined(fix[108] )? defaultHeartbeatSeconds : fix[108];
            var heartbeatInMilliSeconds = parseInt(heartbeatInMilliSecondsStr, 10) * 1000;
            //console.log("heartbeatInMilliSeconds="+heartbeatInMilliSeconds);//debug
            
        	//==Set heartbeat mechanism
            heartbeatIntervalID = setInterval(function () {
            	var currentTime = new Date().getTime();

            	//==send heartbeats
            	if (currentTime - timeOfLastOutgoing > heartbeatInMilliSeconds && sendHeartbeats) {
            		self._send({
            			'35': '0'
            		}); //heartbeat
            	}

            	//==ask counter party to wake up
            	if (currentTime - timeOfLastIncoming > (heartbeatInMilliSeconds * 1.5) && expectHeartbeats) {
            		self._send({
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
                self._send(fix);
            }

        } // End Process logon==
        
        // if (fileLogging) {
        // 	self.logToFile(raw);
        // }

        //==Process seq-reset (no gap-fill)
        if (msgType === '4' && fix['123'] === undefined || fix['123'] === 'N') {
            var resetseqnostr = fix['36'];
            var resetseqno = parseInt(resetseqnostr, 10);
            if (resetseqno >= session.incomingSeqNum) {
                session.incomingSeqNum = resetseqno
            } else {
                var error = '[ERROR] Seq-reset may not decrement sequence numbers: ' + raw;
                throw new Error(error)
            }
        }

        //==Check sequence numbers
        var msgSeqNumStr = fix['34'];
        var msgSeqNum = parseInt(msgSeqNumStr, 10);

        //expected sequence number
        if (msgSeqNum === session.incomingSeqNum) {
            session.incomingSeqNum++;
            isResendRequested = false;
        }
        //less than expected
        else if (msgSeqNum < session.incomingSeqNum) {
            //ignore posdup
            if (fix['43'] === 'Y') {
                return Observable.empty()
            }
            //if not posdup, error
            else {
                logoffmsg = { '8': fixVersion, '49': senderCompID, '56': targetCompID, '35': 5, '58': 'sequence number lower than expected' };
                
                if(senderSubID)
                    logoffmsg['50'] = senderSubID
                
                self.send(logoffmsg)

                var error = '[ERROR] Incoming sequence number ('+msgSeqNum+') lower than expected (' + session.incomingSeqNum+ ') : ' + raw;
                throw new Error(error)
                //fixClient.connection.emit('error', error)
            }
        }
        //greater than expected
        else {
            //is it resend request?
        	if (msgType === '2' && fileLogging) {
        		self.resendMessages(fix['7'], fix['16'])
            }
            //did we already send a resend request?
            self.requestResend()
        }

        //==Process sequence-reset with gap-fill
        if (msgType === '4' && fix['123'] === 'Y') {
            var newSeqNoStr = fix['36'];
            var newSeqNo = parseInt(newSeqNoStr, 10);

            if (newSeqNo >= session.incomingSeqNum) {
                session.incomingSeqNum = newSeqNo;
            } else {
                var error = '[ERROR] Seq-reset may not decrement sequence numbers: ' + raw;
                throw new Error(error)
            }
        }

        //==Check compids and version
        //TODO
        //==Process test request
        if (msgType === '1') {
            var testReqID = fix['112'];
            self._send({
                '35': '0',
                '112': testReqID
            });
        }

        //==Process resend-request
        if (msgType === '2') {
        	self.resendMessages(fix['7'], fix['16']);
        }

        //==Process logout
        if (msgType === '5') {
            
            if (isLogoutRequested) {
                fixClient.connection.destroy();
                self.resetFIXSession(false)
            } else {
                self._send(fix);
            }

            self.emit('logoff', senderCompID, targetCompID);
            fixClient.connection.destroy()//will close connection and force to save the state to disk
        }

        saveSession()
		return fix
    }

    this.logon = function (logonmsg) {
        logonmsg = !logonmsg ? { '35': 'A', '90': '0', '108': '10'} : logonmsg;
        
        if(options.userID && options.password){
            logonmsg['553'] = options.userID
            logonmsg['554'] = options.password
            logonmsg['96'] = options.password
        }

        fixVersion = fixVersion || logonmsg['8'];
        senderCompID = senderCompID || logonmsg['49'];
        targetCompID = targetCompID || logonmsg['56'];
            
        //==Sync sequence numbers from data store
        if (resetSeqNumOnReconect) 
            session = {'incomingSeqNum': 1, 'outgoingSeqNum': 1}
        else
            session = retriveSession(senderCompID, targetCompID)

        this.send(logonmsg)
    }

    this.logoff = function (logoffReason) {
    	logoffmsg = { '35': 5, '58': logoffReason };
        this.send(logoffmsg)
        isLogoutRequested = true
    }

    this.send = function (fix) {
        this.emit('dataOut', fix)

        this._send(fix)
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
            BeginSeqNo = BeginSeqNo ? Number(BeginSeqNo) : undefined
    		EndSeqNo = EndSeqNo ? Number(EndSeqNo) : undefined
    		var reader = fs.createReadStream(this.logfilename, {
    			'flags': 'r',
    			'encoding': 'binary',
    			'mode': 0666,
    			'bufferSize': 4 * 1024
    		})
    		//TODO full lines may not be read
    		reader.addListener("data", function (chunk) {
    			var _fix = fixutil.convertToMap(chunk);
    			var _msgType = _fix[35];
                var _seqNo = Number(_fix[34]);
                
                if((!BeginSeqNo || BeginSeqNo <= _seqNo) && (!EndSeqNo || BeginSeqNo <= _seqNo)){
                    if (_.include(['A', '5', '2', '0', '1', '4'], _msgType)) {
                        //send seq-reset with gap-fill Y
                        self._send({
                            '35': '4',
                            '123': 'Y',
                            '36': _seqNo
                        });
                    } else {
                        //send msg w/ posdup Y
                        self._send(_.extend(_fix, {
                            '43': 'Y'
                        }));
                    }
                }
    		});
    	}
    };

    this.requestResend = function(){
        if (isResendRequested === false) {
            isResendRequested = true;
            //send resend-request
            self._send({
                '35': '2',
                '7': session.incomingSeqNum,
                '16': '0'
            });
        }
    }
    this._send = function(msg){
        var outmsg = fixutil.convertToFIX(msg, fixVersion,  fixutil.getUTCTimeStamp(),
            senderCompID,  targetCompID,  session.outgoingSeqNum, senderSubID);
		
        session.outgoingSeqNum++
        timeOfLastOutgoing = new Date().getTime();
        
        self.emit('fixOut', outmsg)

        if (fileLogging && msg['123'] !== 'Y' && msg['43'] !== 'Y' ) {
        	self.logToFile(outmsg);
        }
        
        fixClient.connection.write(outmsg);
        saveSession()
    }
}

util.inherits(exports.FIXSession, events.EventEmitter);
