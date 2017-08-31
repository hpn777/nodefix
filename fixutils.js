var moment = require('moment')
var _ = require('underscore')
const { fixRepeatingGroups } = require('./resources/fixSchema')
const { resolveKey } = require('./resources/fixtagnums')

var SOHCHAR = exports.SOHCHAR = String.fromCharCode(1);
exports.getUTCTimeStamp = function(){ return moment.utc().format('YYYYMMDD-HH:mm:ss.SSS'); }

var checksum = exports.checksum = function(str){
    var chksm = 0;
    for (var i = 0; i < str.length; i++) {
        chksm += str.charCodeAt(i);
    }

    chksm = chksm % 256;

    var checksumstr = '';
    if (chksm < 10) {
        checksumstr = '00' + (chksm + '');
    }
    else if (chksm >= 10 && chksm < 100) {
        checksumstr = '0' + (chksm + '');
    }
    else {
        checksumstr = '' + (chksm + '');
    }

    return checksumstr;
}

//TODO change name to converMapToFIX
var convertRawToFIX = exports.convertRawToFIX = function(map){
    return convertToFIX(map, map[8], map[52], map[49], map[56], map[34], map[50]);
}

var convertToFIX = exports.convertToFIX = function(msg, fixVersion, timeStamp, senderCompID, targetCompID, outgoingSeqNum, senderSubID){
    fixVersion = msg['8'] || fixVersion;
    var fixMessage = '';
    fixMessage += '35=' + msg['35'] + SOHCHAR;
    fixMessage += '52=' + timeStamp + SOHCHAR;
    fixMessage += '49=' + (msg['49'] || senderCompID) + SOHCHAR;
    if(senderSubID)
        fixMessage += '50=' + (msg['50'] || senderSubID) + SOHCHAR;
    fixMessage += '56=' + (msg['56'] || targetCompID) + SOHCHAR;
    fixMessage += '34=' + outgoingSeqNum + SOHCHAR;

    ['8', '9', '35', '10', '52', '49', '50', '56', '34'].forEach((x)=>{ delete msg[x] })

    _.each(msg, (item, tag) => {
        if(Array.isArray(item)){
            fixMessage += tag + '=' + item.length + SOHCHAR
            item.forEach((group)=>{
                _.each(group, (item, tag) => {
                    fixMessage += tag + '=' + item + SOHCHAR
                })
            })
        }
        else{
            fixMessage += tag + '=' + item + SOHCHAR
        }
    })

    const messageLength = fixMessage.length

    fixMessage = '9=' + messageLength + SOHCHAR + fixMessage
    fixMessage = '8=' + fixVersion + SOHCHAR + fixMessage

    fixMessage += '10=' + checksum(fixMessage) + SOHCHAR;
        
    return fixMessage;
}

var convertToMap = exports.convertToMap = function(msg) {
    var fix = {}
    var keyvals = msg.split(SOHCHAR)
        .map( (x)=> x.split('=') )
    
    var i = 0;
    while( i < keyvals.length ){
        var pair = keyvals[i]
        if(pair.length === 2){
            var repeatinGroup = fixRepeatingGroups[pair[0]]
            if(repeatinGroup === undefined){
                fix[pair[0]] = pair[1]
                i++
            }
            else{
                var nr = Number(pair[1])
                if(nr){
                    fix[pair[0]] = repeatingGroupToMap(repeatinGroup, nr, keyvals.slice(i+1, i+1 + (nr * repeatinGroup.length)))
                    i += (1 + (nr * repeatinGroup.length))
                }
                else{
                    throw new Error('Repeating Group: "' + pair.join('=') + '" is invalid')
                }
            }
        }
        else
            i++
    }

    return fix;
}

var convertToJSON = exports.convertToJSON = function(msg) {
    var fix = {}
    var keyvals = msg.split(SOHCHAR)
        .map( (x)=> x.split('=') )

    var i = 0;
    while( i < keyvals.length ){
        var pair = keyvals[i]
        if(pair.length === 2){
            var repeatinGroup = fixRepeatingGroups[pair[0]]
            if(repeatinGroup === undefined){
                fix[resolveKey(pair[0])] = pair[1]
                i++
            }
            else{
                var nr = Number(pair[1])
                if(nr){
                    fix[resolveKey(pair[0])] = repeatingGroupToJSON(repeatinGroup, nr, keyvals.slice(i+1, i+1 + (nr * repeatinGroup.length)))
                    i += (1 + (nr * repeatinGroup.length))
                }
                else{
                    throw new Error('Repeating Group: "' + pair.join('=') + '" is invalid')
                }
            }
        }
        else
            i++
    }

    return fix;
}

var repeatingGroupToMap = function(repeatinGroup, nr, keyvals){
    var response = []
    for(var i = 0, k = 0; i < nr; i++){
        var group = {}
        
        repeatinGroup.forEach((key)=>{
            if(key === keyvals[k][0])
                group[key] = keyvals[k][1]
            else 
                throw new Error('Repeating Group: "' + JSON.stringify(keyvals) + '" is invalid')

            k++
        })

        response.push(group)
    }
    return response
}

var repeatingGroupToJSON = function(repeatinGroup, nr, keyvals){
    var response = []
    for(var i = 0, k = 0; i < nr; i++){
        var group = {}
        
        repeatinGroup.forEach((key)=>{
            if(key === keyvals[k][0])
                group[resolveKey(key)] = keyvals[k][1]
            else 
                throw new Error('Repeating Group: "' + JSON.stringify(keyvals) + '" is invalid')

            k++
        })

        response.push(group)
    }
    return response
}