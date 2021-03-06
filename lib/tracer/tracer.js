var Fibers = Npm.require('fibers');
var eventLogger = Npm.require('debug')('kadira:tracer');
var REPITITIVE_EVENTS = {'db': true, 'http': true, 'email': true, 'wait': true, 'async': true, 'function': true};

Tracer = function Tracer() {
  this._filters = [];
};

//In the future, we might wan't to track inner fiber events too.
//Then we can't serialize the object with methods
//That's why we use this method of returning the data
Tracer.prototype.start = function(session, msg) {
  var traceInfo = {
    _id: session.id + "::" + msg.id,
    session: session.id,
    userId: session.userId,
    id: msg.id,
    events: []
  };

  if(msg.msg == 'method') {
    traceInfo.type = 'method';
    traceInfo.name = msg.method;
  } else if(msg.msg == 'sub') {
    traceInfo.type = 'sub';
    traceInfo.name = msg.name;
  } else {
    return null;
  }
  traceInfo.nestedTraces = Kadira.nestedTraces;
  traceInfo.useful = function() {
    return this.events.some(e => !e.type.startsWith("async") || (e._nestedTrace && e._nestedTrace.useful()));
  }
  return traceInfo;
};

const MAX_NESTED_DEPTH = 3;
Tracer.prototype.event = function(traceInfo, type, data) {
  // do not allow to proceed, if already completed or errored
  var lastEvent = this.getLastEvent(traceInfo);
  if(lastEvent && ['complete', 'error'].indexOf(lastEvent.type) >= 0) {
    return false;
  }

  //expecting a end event
  var eventId = true;
  //specially handling for repitivive events like db, http
  if(REPITITIVE_EVENTS[type]) {
    //can't accept a new start event
    if(traceInfo._lastEventId) {
      if (traceInfo._nestedTrace) {
        return this.event(traceInfo._nestedTrace, type, data);
      }
      return false;
    }
    if (traceInfo.nestedTraces && (!traceInfo.nestedDepth || traceInfo.nestedDepth < MAX_NESTED_DEPTH)) {
      traceInfo._nestedTrace = this.start({id: traceInfo._id.split("::")[0]}, {id: traceInfo._id.split("::")[1], msg: traceInfo.type, method: traceInfo.name, name: traceInfo.name});
      traceInfo._nestedTrace.nestedDepth = (traceInfo.nestedDepth || 0) + 1;
    }
    eventId = traceInfo._lastEventId = DefaultUniqueId.get();
  }

  var event = {type: type, at: Ntp._now()};
  if(data) {
    var info = _.pick(traceInfo, 'type', 'name')
    event.data = this._applyFilters(type, data, info, "start");;
  }

  traceInfo.events.push(event);

  eventLogger("%s %s", type, traceInfo._id);
  return eventId;
};

Tracer.prototype.eventEnd = function(traceInfo, eventId, data) {
  if(traceInfo._lastEventId && traceInfo._lastEventId == eventId) {
    var lastEvent = this.getLastEvent(traceInfo);
    var type = lastEvent.type + 'end';
    var event = {type: type, at: Ntp._now()};
    if (traceInfo._nestedTrace && traceInfo._nestedTrace.events.length) {
      if (traceInfo._nestedTrace.useful()) {
        this.endLastEvent(traceInfo._nestedTrace);
        this.event(traceInfo._nestedTrace, "complete");
        event._nestedTrace = traceInfo._nestedTrace;
      }
    }
    delete traceInfo._nestedTrace;
    if(data) {
      var info = _.pick(traceInfo, 'type', 'name')
      event.data = this._applyFilters(type, data, info, "end");;
    }
    traceInfo.events.push(event);
    eventLogger("%s %s", type, traceInfo._id);

    traceInfo._lastEventId = null;
    return true;
  }
  else if (traceInfo._nestedTrace) {
    this.eventEnd(traceInfo._nestedTrace, eventId, data);
  }
  else {
    return false;
  }
};

Tracer.prototype.getLastEvent = function(traceInfo) {
  return traceInfo.events[traceInfo.events.length -1]
};

Tracer.prototype.endLastEvent = function(traceInfo) {
  var lastEvent = this.getLastEvent(traceInfo);
  if(lastEvent && !/end$/.test(lastEvent.type)) {
    traceInfo.events.push({
      type: lastEvent.type + 'end',
      at: Ntp._now()
    });
    return true;
  }
  return false;
};

Tracer.prototype.buildTrace = function(traceInfo, nested = false) {
  var firstEvent = traceInfo.events[0];
  var lastEvent = traceInfo.events[traceInfo.events.length - 1];
  var processedEvents = [];

  if(!nested && firstEvent.type != 'start') {
    console.warn('Kadira: trace is not started yet');
    return null;
  } else if(!nested && lastEvent.type != 'complete' && lastEvent.type != 'error') {
    //trace is not completed or errored yet
    console.warn('Kadira: trace is not completed or errored yet');
    return null;
  } else {
    //build the metrics
    traceInfo.errored = lastEvent.type == 'error';
    traceInfo.at = firstEvent.at;

    var metrics = {
      total: lastEvent.at - firstEvent.at,
    };

    var totalNonCompute = 0;

    firstEvent = ['start', 0];
    if(traceInfo.events[0].data || nested) firstEvent.push(traceInfo.events[0].data || {});
    if (nested) {
      firstEvent[2].nested = nested;
      firstEvent.push(new Date());
    }
    processedEvents.push(firstEvent);

    for(var lc=(nested ? 0 : 1); lc < traceInfo.events.length - 1; lc += 2) {
      var prevEventEnd = traceInfo.events[lc-1];
      var startEvent = traceInfo.events[lc];
      var endEvent = traceInfo.events[lc+1];
      var computeTime = !prevEventEnd ? 0 : startEvent.at - prevEventEnd.at;
      if(computeTime > 0) processedEvents.push(['compute', computeTime, { depth: nested }]);
      if (!Kadira.upgradedUI && startEvent.type === "function") {
        startEvent.type = "db";
        startEvent.data.coll = "functionCall." + startEvent.data.name;
        startEvent.data.func = "enter";
        endEvent.type = "dbend";
        traceInfo.events.splice(lc + 2, 0, {
          type: "db",
          data: {
            coll: "functionCall." + startEvent.data.name,
            func: "exit"
          }
        }, {type: "dbend"})
      }
      if(!endEvent) {
        console.error('Kadira: no end event for type: ', startEvent.type);
        return null;
      } else if(endEvent.type != startEvent.type + 'end') {
        console.error('Kadira: endevent type mismatch: ', startEvent.type, endEvent.type, JSON.stringify(traceInfo));
        return null;
      } else {
        var elapsedTimeForEvent = endEvent.at - startEvent.at
        var currentEvent = [startEvent.type, elapsedTimeForEvent];
        currentEvent.push(_.extend({depth: nested || 0}, startEvent.data, endEvent.data));
        processedEvents.push(currentEvent);
        if (endEvent._nestedTrace) {
          this.buildTrace(endEvent._nestedTrace, !nested ? 1 : (nested + 1));
          if (Kadira.upgradedUI) {
            processedEvents.push.apply(processedEvents, endEvent._nestedTrace.events.slice(1, endEvent._nestedTrace.events.length - 1));
          }
          else {
            processedEvents.push.apply(processedEvents, endEvent._nestedTrace.events);
          }
          Object.keys(endEvent._nestedTrace.metrics).forEach(type => {
            if (type !== "total") {
              metrics[type] = (metrics[type] || 0) + (endEvent._nestedTrace.metrics[type] || 0);
            }
          });
        }
        metrics[startEvent.type] = metrics[startEvent.type] || 0;
        metrics[startEvent.type] += elapsedTimeForEvent;
        totalNonCompute += elapsedTimeForEvent;
      }
    }

    computeTime = lastEvent.at - traceInfo.events[traceInfo.events.length - 2];
    if(computeTime > 0) processedEvents.push(['compute', computeTime]);

    var lastEventData = [nested ? "complete" : lastEvent.type, 0];
    if(lastEvent.data || nested) lastEventData.push(lastEvent.data || {});
    if (nested) {
      lastEventData[2].nested = nested;
      lastEventData.push({endTime: new Date(), totalValue: lastEvent.at - firstEvent.at});
    }
    processedEvents.push(lastEventData);

    metrics.compute = metrics.total - totalNonCompute;
    traceInfo.metrics = metrics;
    traceInfo.events = processedEvents;
    traceInfo.isEventsProcessed = true;
    return traceInfo;
  }
};

Tracer.prototype.addFilter = function(filterFn) {
  this._filters.push(filterFn);
};

Tracer.prototype._applyFilters = function(eventType, data, info) {
  this._filters.forEach(function(filterFn) {
    data = filterFn(eventType, _.clone(data), info);
  });

  return data;
};

Tracer.prototype.enteredFunction = function(name) {
  try {
    info = Kadira._getInfo();
    if (info) {
      return Kadira.tracer.event(info.trace, "function", { name });
    }
  }
  catch (e) {
    console.warn(e);
    return false;
  }
};

Tracer.prototype.forceTrace = function() {
  try {
    const info = Kadira._getInfo();
    if (info) {
      info.trace.outlier = true;
    }
  }
  catch (e) {
    console.warn(e);
  }
}
Tracer.prototype.traceFunction = function(name, callback) {
  const eventId = this.enteredFunction(name);
  const ret = callback();
  if (eventId) {
    Kadira.tracer.eventEnd(Kadira._getInfo().trace, eventId);
  }
  return ret;
}

Kadira.tracer = new Tracer();
// need to expose Tracer to provide default set of filters
Kadira.Tracer = Tracer;
