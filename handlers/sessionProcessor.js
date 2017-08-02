exports.newSessionProcessor = function (isAcceptor, options) {
    return new sessionProcessor(isAcceptor, options);
};

var util = require('util');
var fs = require('fs');
var fixutil = require('../fixutils.js');
var _  = require('underscore');


//TODO make sure 'ignored' messages really are not forwarded to the next handler
//TODO instead of datastore function as param, expect a data structure which:
//--ds.queue.add(sender,target,value)
//--ds.hash.put(sender,target,value)
//--ds.queue.get(sender,target,callback)
//--ds.hash.get(sender,target,callback)
//TODO outgoing message handling
//TODO Normalize input parameters


function sessionProcessor(isAcceptor, options) {
    
    var self = this;

    this.isAcceptor = isAcceptor;
    this.isInitiator = !isAcceptor;

    this.isDuplicateFunc = _.isUndefined(options.isDuplicateFunc)? function () {return false;} : options.isDuplicateFunc;
    this.isAuthenticFunc = _.isUndefined(options.isAuthenticFunc)? function () {return true;} : options.isAuthenticFunc;
    this.getSeqNums = _.isUndefined(options.getSeqNums)? function () { return {'incomingSeqNum': 1, 'outgoingSeqNum': 1 }; } : options.getSeqNums;
    this.datastore = _.isUndefined(options.datastore)? function () {} : options.datastore ;
    
    this.fixVersion = null;
    this.senderCompID = null;
    this.targetCompID = null;

    this.defaultHeartbeatSeconds = _.isUndefined(options.defaultHeartbeatSeconds)? "10" : options.defaultHeartbeatSeconds;

    this.sendHeartbeats = _.isUndefined(options.sendHeartbeats)? true : options.sendHeartbeats;
    this.expectHeartbeats = _.isUndefined(options.expectHeartbeats)? true : options.expectHeartbeats ;
    this.respondToLogon = _.isUndefined(options.respondToLogon)? true : options.respondToLogon;
    this.resetSeqNumOnReconect = _.isUndefined(options.resetSeqNumOnReconect) ? true : options.resetSeqNumOnReconect;

    this.isLoggedIn = false;
    this.heartbeatIntervalID = "";
    this.timeOfLastIncoming = new Date().getTime();
    this.timeOfLastOutgoing = new Date().getTime();
    this.testRequestID = 1;
    this.incomingSeqNum = null;
    this.outgoingSeqNum = null;
    this.isResendRequested = false;
    this.isLogoutRequested = false;

    this.file = null;
    this.fileLogging = _.isUndefined(options.fileLogging) ? options.fileLogging : true;

    //||||||||||INCOMING||||||||||INCMOING||||||||||INCOMING||||||||||INCOMING||||||||||INCOMING||||||||||INCOMING||||||||||
    this.incoming = function (ctx, event) {
        if (event.type !== 'data') {
            ctx.sendNext(event);
            return;
        }

        self.timeOfLastIncoming = new Date().getTime();

        //==Convert to key/val map==
        var raw = event.data;
        var fix = fixutil.convertToMap(raw);

        var msgType = fix['35'];

        //==Confirm first msg is logon==
        if (self.isLoggedIn === false && msgType !== 'A') {
            var error = '[ERROR] First message must be logon:' + raw;
            util.log(error);
            ctx.stream.end();
            ctx.sendNext({
                data: error,
                type: 'error'
            });
            return;
        }

        //==Process logon 
        else if (self.isLoggedIn === false && msgType === 'A') {
            self.fixVersion = fix['8'];
            //incoming sender and target are swapped because we want sender/comp
            //from our perspective, not the counter party's
            self.senderCompID = fix['56'];
            self.targetCompID = fix['49'];

            //==Process acceptor specific logic (Server)
            if (self.isAcceptor) {
                //==Check duplicate connections
                if (self.isDuplicateFunc(self.senderCompID, self.targetCompID)) {
                    var error = '[ERROR] Session already logged in:' + raw;
                    util.log(error);
                    ctx.stream.end();
                    ctx.sendNext({
                        data: error,
                        type: 'error'
                    });
                    return;
                }

                //==Authenticate connection
                if (!self.isAuthenticFunc(fix, ctx.stream.remoteAddress)) {
                    var error = '[ERROR] Session not authentic:' + raw;
                    util.log(error);
                    ctx.stream.end();
                    ctx.sendNext({
                        data: error,
                        type: 'error'
                    });
                    return;
                }
                
                //==Sync sequence numbers from data store
                var seqnums = self.getSeqNums(self.senderCompID, self.targetCompID);
                self.incomingSeqNum = seqnums.incomingSeqNum;
                self.outgoingSeqNum = seqnums.outgoingSeqNum;

            } //End Process acceptor specific logic==


            var heartbeatInMilliSecondsStr = _.isUndefined(fix[108] )? self.defaultHeartbeatSeconds : fix[108];
            var heartbeatInMilliSeconds = parseInt(heartbeatInMilliSecondsStr, 10) * 1000;
            //console.log("heartbeatInMilliSeconds="+heartbeatInMilliSeconds);//debug

        	//==Set heartbeat mechanism
            self.heartbeatIntervalID = setInterval(function () {
            	var currentTime = new Date().getTime();

            	//==send heartbeats
            	if (currentTime - self.timeOfLastOutgoing > heartbeatInMilliSeconds && self.sendHeartbeats) {
            		self.sendMsg(ctx.sendPrev, {
            			'35': '0'
            		}); //heartbeat
            	}

            	//==ask counter party to wake up
            	if (currentTime - self.timeOfLastIncoming > (heartbeatInMilliSeconds * 1.5) && self.expectHeartbeats) {
            		self.sendMsg(ctx.sendPrev, {
            			'35': '1',
            			'112': self.testRequestID++
            		}); //test req id
            	}

            	//==counter party might be dead, kill connection
            	if (currentTime - self.timeOfLastIncoming > heartbeatInMilliSeconds * 2 && self.expectHeartbeats) {
            		var error = self.targetCompID + '[ERROR] No heartbeat from counter party in milliseconds ' + heartbeatInMilliSeconds * 1.5;
            		util.log(error);
            		ctx.stream.end();
            		ctx.sendNext({
            			data: error,
            			type: 'error'
            		});
            		return;
            	}

            }, heartbeatInMilliSeconds / 2); //End Set heartbeat mechanism==
            //==When session ends, stop heartbeats            
            ctx.stream.on('end', function () {
                clearInterval(self.heartbeatIntervalID);
            });

            //==Logon successful
            self.isLoggedIn = true;
            ctx.stream.emit('logon', self.senderCompID, self.targetCompID);
            //==Logon ack (acceptor)
            if (self.isAcceptor && self.respondToLogon) {
                /*var loginack = _.clone(fix);
                loginack[49] = fix[56];
                loginack[56] = fix[49];
                self.sendMsg(ctx.sendPrev,loginack);*/
                self.sendMsg(ctx.sendPrev,fix);
            }

        } // End Process logon==
        
        if (self.fileLogging) {
        	self.logToFile(raw);
        }

        //==Process seq-reset (no gap-fill)
        if (msgType === '4' && fix['123'] === undefined || fix['123'] === 'N') {
            var resetseqnostr = fix['36'];
            var resetseqno = parseInt(resetseqno, 10);
            if (resetseqno >= self.incomingSeqNum) {
                self.incomingSeqNum = resetseqno
            } else {
                var error = '[ERROR] Seq-reset may not decrement sequence numbers: ' + raw;
                util.log(error);
                ctx.stream.end();
                ctx.sendNext({
                    data: error,
                    type: 'error'
                });
                return;
            }
        }

        //==Check sequence numbers
        var msgSeqNumStr = fix['34'];
        var msgSeqNum = parseInt(msgSeqNumStr, 10);

        console.log('swq numbrers',msgSeqNum,self.incomingSeqNum)
        //expected sequence number
        if (msgSeqNum === self.incomingSeqNum) {
            self.incomingSeqNum++;
            self.isResendRequested = false;
        }
        //less than expected
        else if (msgSeqNum < self.incomingSeqNum) {
            //ignore posdup
            if (fix['43'] === 'Y') {
                return;
            }
            //if not posdup, error
            else {
                var error = '[ERROR] Incoming sequence number ('+msgSeqNum+') lower than expected (' + self.incomingSeqNum+ ') : ' + raw;
                util.log(error);
                ctx.stream.end();
                ctx.sendNext({
                    data: error,
                    type: 'error'
                });
                return;
            }
        }
        //greater than expected
        else {
            //is it resend request?
        	if (msgType === '2' && self.fileLogging) {
        		self.resendMessages(ctx);
            }
            //did we already send a resend request?
            if (self.isResendRequested === false) {
                self.isResendRequested = true;
                //send resend-request
                self.sendMsg(ctx.sendPrev,{
                        '35': '2',
                        '7': self.incomingSeqNum,
                        '16': '0'
                    });
            }
        }

        //==Process sequence-reset with gap-fill
        if (msgType === '4' && fix['123'] === 'Y') {
            var newSeqNoStr = fix['36'];
            var newSeqNo = parseInt(newSeqNoStr, 10);

            if (newSeqNo >= self.incomingSeqNum) {
                self.incomingSeqNum = newSeqNo;
            } else {
                var error = '[ERROR] Seq-reset may not decrement sequence numbers: ' + raw;
                util.log(error);
                ctx.stream.end();
                ctx.sendNext({
                    data: error,
                    type: 'error'
                });
                return;
            }
        }

        //==Check compids and version
        //TODO
        //==Process test request
        if (msgType === '1') {
            var testReqID = fix['112'];
            self.sendMsg(ctx.sendPrev,{
                '35': '0',
                '112': testReqID
            });
        }

        //==Process resend-request
        if (msgType === '2') {
        	self.resendMessages(ctx);
        }

        //==Process logout
        if (msgType === '5') {
            if (self.isLogoutRequested) {
                ctx.stream.end();
            } else {
                self.sendMsg(ctx.sendPrev,fix);
            }
            ctx.stream.emit('logoff', self.senderCompID, self.targetCompID);
        }
        
        ctx.sendNext({data:fix, fixMsg:raw, type:'data'});
    }

    //||||||||||OUTGOING||||||||||OUTGOING||||||||||OUTGOING||||||||||OUTGOING||||||||||OUTGOING||||||||||OUTGOING||||||||||
    this.outgoing = function (ctx, event) {
        if(event.type !== 'data'){
            ctx.sendNext(event);
            return;
        }
            
        var fix = event.data;

        var msgType = fix['35'];

        if(self.isLoggedIn === false && msgType === "A"){
            self.fixVersion = fix['8'];
            self.senderCompID = fix['49'];
            self.targetCompID = fix['56'];
                
        	//==Sync sequence numbers from data store
            if (self.resetSeqNumOnReconect) {
            	var seqnums = self.getSeqNums(self.senderCompID, self.targetCompID);
            	self.incomingSeqNum = seqnums.incomingSeqNum;
            	self.outgoingSeqNum = seqnums.outgoingSeqNum;
            }
        }
            
        self.sendMsg(ctx.sendNext, fix);
    }
        
        
	//||||||||||UTILITY||||||||||UTILITY||||||||||UTILITY||||||||||UTILITY||||||||||UTILITY||||||||||UTIILTY||||||||||
    this.logToFile = function(raw){
        if (self.file === null) {
        	fs.mkdir('./traffic', { 'flags': 'a+' }, function (err) {
        		if (!err || (err && err.code == 'EEXIST')) {
        			this.logfilename = './traffic/' + self.senderCompID + '_' + self.targetCompID + '.log';
        			fs.unlink(this.logfilename);
        			self.file = fs.createWriteStream(this.logfilename, { 'flags': 'a+' });
        			self.file.on('error', function (err) { console.log(err); });//todo print good log, end session
        			self.file.write(raw + '\n');
        		}
        	});
        }
        else
			self.file.write(raw + '\n');
    }

    this.resendMessages = function (ctx) {
    	if (this.logfilename) {
    		var reader = fs.createReadStream(this.logfilename, {
    			'flags': 'r',
    			'encoding': 'binary',
    			'mode': 0666,
    			'bufferSize': 4 * 1024
    		})
    		//TODO full lines may not be read
    		reader.addListener("data", function (chunk) {
    			var _fix = fixutil.converToMap(chunk);
    			var _msgType = _fix[35];
    			var _seqNo = _fix[34];
    			if (_.include(['A', '5', '2', '0', '1', '4'], _msgType)) {
    				//send seq-reset with gap-fill Y
    				self.sendMsg(ctx.sendPrev, {
    					'35': '4',
    					'123': 'Y',
    					'36': _seqNo
    				});
    			} else {
    				//send msg w/ posdup Y
    				self.sendMsg(ctx.sendPrev, _.extend(_fix, {
    					'43': 'Y'
    				}));
    			}
    		});
    	}
    };

    this.sendMsg = function(senderFunc, msg){
        var outmsg = fixutil.convertToFIX(msg, self.fixVersion,  fixutil.getUTCTimeStamp(new Date()),
            self.senderCompID,  self.targetCompID,  self.outgoingSeqNum);

        self.outgoingSeqNum = self.outgoingSeqNum + 1;
        self.timeOfLastOutgoing = new Date().getTime();
        
        if (self.fileLogging) {
        	self.logToFile(outmsg);
        }

        senderFunc({data:outmsg, type:'data'});
    }
}
