var SOHCHAR = exports.SOHCHAR = String.fromCharCode(1);

exports.getCurrentUTCTimeStamp = function(){ return getUTCTimeStamp(new Date()); }

var getUTCTimeStamp = exports.getUTCTimeStamp = function(datetime){
    var timestamp = datetime || new Date();

    var year = timestamp.getUTCFullYear();
    var month = timestamp.getUTCMonth() +1;
    var day = timestamp.getUTCDate();
    var hours = timestamp.getUTCHours();
    var minutes = timestamp.getUTCMinutes();
    var seconds = timestamp.getUTCSeconds();
    var millis = timestamp.getUTCMilliseconds();


    if (month < 10) { month = '0' + month;}

    if (day < 10) { day = '0' + day;}

    if (hours < 10) { hours = '0' + hours;}

    if (minutes < 10) { minutes = '0' + minutes;}

    if (seconds < 10) { seconds = '0' + seconds;}

    if (millis < 10) {
        millis = '00' + millis;
    } else if (millis < 100) {
        millis = '0' + millis;
    }


    var ts = [year, month, day, '-' , hours, ':' , minutes, ':' , seconds, '.' , millis].join('');

    return ts;
}

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
    return convertToFIX(map, map[8], map[52], map[49], map[56], map[34]);
}

var convertToFIX = exports.convertToFIX = function(msgraw, fixVersion, timeStamp, senderCompID, targetCompID, outgoingSeqNum){
    //defensive copy
	var msg = msgraw;
    //for (var tag in msgraw) {
    //    if (msgraw.hasOwnProperty(tag)) msg[tag] = msgraw[tag];
    //}

    delete msg['9']; //bodylength
    delete msg['10']; //checksum

    var headermsgarr = [];
    var bodymsgarr = [];
    //var trailermsgarr = [];

    headermsgarr.push('35=' + msg['35'] , SOHCHAR);
    headermsgarr.push('52=' + timeStamp , SOHCHAR);
    headermsgarr.push('49=' + (msg['49'] || senderCompID) , SOHCHAR);
    headermsgarr.push('56=' + (msg['56'] || targetCompID) , SOHCHAR);
    headermsgarr.push('34=' + outgoingSeqNum , SOHCHAR);

    for (var tag in msg) {
        if (tag !== '8'
            && tag !== '9'
            && tag !== '35'
            && tag !== '10'
            && tag !== '52'
            && tag !== '49'
            && tag !== '56'
            && tag !== '34'
            && tag !== ""
            ) bodymsgarr.push(tag, '=' , msg[tag] , SOHCHAR);
    }

    var headermsg = headermsgarr.join('');
    //var trailermsg = trailermsgarr.join('');
    var bodymsg = bodymsgarr.join('');

    var outmsgarr = [];
    outmsgarr.push('8=', msg['8'] || fixVersion, SOHCHAR);
    outmsgarr.push('9=' , (headermsg.length + bodymsg.length) , SOHCHAR);
    outmsgarr.push(headermsg);
    outmsgarr.push(bodymsg);
    //outmsgarr.push(trailermsg);

    var outmsg = outmsgarr.join('');

    outmsg += '10=' + checksum(outmsg) + SOHCHAR;
        
    return outmsg;
}

var convertToMap = exports.convertToMap = function(msg) {
    var fix = {};
    var keyvals = msg.split(SOHCHAR)
        .map((x)=>{ return x.split('=')})
        .forEach((x) => { 
            if(x[1])
                fix[x[0]] = x[1]; 
        });

    return fix;
}
