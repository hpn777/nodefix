exports.newOutMsgEvtInterceptor = function(session) {
    return new outMsgEvtInterceptor(session);
};

var fixutil = require('../fixutils.js');

function outMsgEvtInterceptor(session){
    var self = this;

    this.incoming = function(ctx, event){
        ctx.sendNext(event);
     }
     
    this.outgoing = function(ctx, event){
        if(event.type==='data'){
        	var fixmap = fixutil.convertToMap(event.data);
        	session.sessionEmitter.emit('outgoingmsg', { senderId: fixmap[49], targetId: fixmap[56], msg: fixmap, fixMsg: event.data });
        }
        else if(event.type==='resync'){
            session.sessionEmitter.emit('outgoingresync',event.data[49], event.data[56], event.data);
        }

        ctx.sendNext(event);
    }
}
