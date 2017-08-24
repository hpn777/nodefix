var fixutil = require('../fixutils.js');
var util = require('util');
var { Observable } = require('rx')

//static vars
const SOHCHAR = String.fromCharCode(1)
const ENDOFTAG8 = 10
const SIZEOFTAG10 = 8
const ENDOFMSGSTR = SOHCHAR + '10='

exports.FrameDecoder = function($){
    var buffer = '';
    var self = this;

    this.decode = (data) => {
        buffer = buffer + data.toString();
		var messages = []

        while (buffer.length > 0) {
            //====================================Step 1: Extract complete FIX message====================================

            //If we don't have enough data to start extracting body length, wait for more data
            if (buffer.length <= ENDOFTAG8) {
                return Observable.empty()
            }

            var bodyLength
            var idxOfEndOfTag10 = buffer.indexOf(ENDOFMSGSTR)
            if(idxOfEndOfTag10 === -1){
                return Observable.empty()
            }
            else{//Message received!
                var msgLength = idxOfEndOfTag10 + SIZEOFTAG10;
                var msg = buffer.substring(0, msgLength);
		
                if (msgLength == buffer.length) {
                    buffer = '';
                }
                else {
                    buffer = buffer.substring(msgLength)
                }
            }
            //====================================Step 2: Validate message====================================

            var calculatedChecksum = fixutil.checksum(msg.substr(0, msg.length - 7));
            var extractedChecksum = msg.substr(msg.length - 4, 3);

            if (calculatedChecksum !== extractedChecksum) {
                var error = '[WARNING] Discarding message because body length or checksum are wrong (expected checksum: '
                    + calculatedChecksum + ', received checksum: ' + extractedChecksum + '): [' + msg + ']'
                throw new Error(error)
            }

			messages.push(msg)
			//return msg
		}
		return Observable.fromArray(messages)
    }
}
