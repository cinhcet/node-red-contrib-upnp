"use strict";

var xml2js = require('xml2js');

function MediaBrowser(upnpConfig) {
  var me = this;
  me.upnpConfiguration = upnpConfig;
}

MediaBrowser.prototype.browseContent = function(objectID, type, returnRaw, nonDefaultParameter, callback) {
  var me = this;
  var serviceType = 'urn:schemas-upnp-org:service:ContentDirectory:1';
  var params = {ObjectID: objectID, Filter: "*", StartingIndex: 0};
  if(type === "children") {
    params.BrowseFlag =  "BrowseDirectChildren";
  } else if(type === "metadata") {
    params.BrowseFlag =  "BrowseMetadata";
  } else {
    callback(new Error('unknown browse type'));
  }
  if(nonDefaultParameter) {
    Object.assign(params, nonDefaultParameter);
  }
  me.upnpConfiguration.upnpClient.invokeActionParsed('Browse', params, serviceType, function(err, result) {
    if(err) {
      callback(new Error("Error " + err + '; RAW: ' + result));
    } else {
      if(result) {
        var browseResult = result;
        if(browseResult['BrowseResponse'] && browseResult['BrowseResponse']['Result'] && browseResult['BrowseResponse']['NumberReturned'] && browseResult['BrowseResponse']['TotalMatches']) {
          var numberReturned = browseResult['BrowseResponse']['NumberReturned'];
          var totalMatches = browseResult['BrowseResponse']['TotalMatches'];
          browseResult = browseResult['BrowseResponse']['Result'];

          var returnObj = {numberReturned: numberReturned, totalMatches: totalMatches};
          if(returnRaw) {
            returnObj.rawXML = browseResult;
          }
          if(numberReturned === "0") {
            callback(null, returnObj);
          } else {
            var parseXML = require('xml2js').parseString;
            parseXML(browseResult, {explicitArray: true}, function(err, parsedData) {
              if(err) {
                callback(new Error(err));
              } else {
                if(parsedData['DIDL-Lite']) {
                  returnObj.obj = parsedData['DIDL-Lite'];
                  delete returnObj.obj['$'];
                  callback(null, returnObj);
                } else {
                  callback(new Error("Problem with UPnP response"));
                }
              }
            });
          }
        } else {
          callback(new Error("UPnP response malformed"));
        }
      } else {
        callback(new Error("Problem with UPnP response"));
      }
    }
  });
}

MediaBrowser.prototype.browseObjectID = function(objectID, startingIndex, requestedCount, callback) {
  var me = this;
  var returnObj = {};
  me.browseContent(objectID, 'children', false, {StartingIndex: startingIndex, RequestedCount: requestedCount}, function(err, result) {
    if(err) {
      callback(err);
    } else {
      returnObj.children = {};
      returnObj.children.totalMatches = result.totalMatches;
      returnObj.children.numberReturned = result.numberReturned;
      if(result.obj && Object.keys(result.obj).length) {
        Object.assign(returnObj.children, result.obj);
      }
      me.browseContent(objectID, 'metadata', false, null, function(err, result) {
        if(err) {
          callback(err);
        } else {
          if(result.numberReturned === "1") {
            returnObj.metadata = result.obj;
            callback(null, returnObj);
          } else {
            callback(new Error("No metadata"));
          }
        }
      });
    }
  });
}

MediaBrowser.prototype.browseAllChildren = function(objectID, callback) {
  var me = this;

  function browseAllChildrenRecursively(objectID, itemList) {
    var deferredPromise = Promise.defer();

    me.browseContent(objectID, 'children', false, null, function(err, result) {
      if(err) {
        deferredPromise.reject(err);
      } else {
        if(result.obj) {
          // add items of current container
          if(result.obj.item && result.obj.item.length) {
            result.obj.item.forEach(function(item) {
              itemList.push(item);
            });
          }
          // if container, recursive call
          if(result.obj.container && result.obj.container.length) {
            // promise which waits for all sub promises to be fulfilled
            Promise.all(result.obj.container.map(function(container) {
              return browseAllChildrenRecursively(container['$']['id'], itemList)
            }))
            .then(function() {
              deferredPromise.resolve();
            });
          } else { // no more container
            deferredPromise.resolve();
          }
        } else {
          deferredPromise.reject(new Error('no obj element'));
        }
      }
    });

    return deferredPromise.promise;
  }

  var items = [];
  browseAllChildrenRecursively(objectID, items)
  .then(function() {
    callback(null, items);
  }, function(err) {
    callback(err);
  });
}


function convertInnerDIDL(item) {
  var temp = {};
  temp.name = item['dc:title'][0];
  temp.id = item['$']['id'];
  if(item['dc:creator']) temp.creator = item['dc:creator'][0];
  if(item['upnp:artist']) temp.artist = item['upnp:artist'][0];
  if(item['dc:date']) temp.date = item['dc:date'][0];
  if(item['upnp:album']) temp.album = item['upnp:album'][0];
  if(item['upnp:genre']) temp.genre = item['upnp:genre'][0];
  if(item['upnp:originalTrackNumber']) temp.trackNumber = item['upnp:originalTrackNumber'][0];
  if(item['upnp:albumArtURI']) temp.albumArtURI = item['upnp:albumArtURI'][0]['_'];
  if(item['res']) {
    var res = item['res'][0];
    temp.file = res['_'];
    if(res['$'] && res['$']['duration']) {
      temp.duration = res['$']['duration'];
    }
  }
  return temp;
}

function parseRawDIDLItem(didl, callback) {
  var parseXML = require('xml2js').parseString;
  parseXML(didl, {explicitArray: true}, function(err, parsedData) {
    if(err) {
      callback(new Error(err));
    } else {
      if(parsedData && parsedData['DIDL-Lite'] && parsedData['DIDL-Lite']['item'] && parsedData['DIDL-Lite']['item'].length) {
        var returnObj = parsedData['DIDL-Lite']['item'][0];
        returnObj = convertInnerDIDL(returnObj);
        callback(null, returnObj);
      } else {
        callback(new Error("Problem with UPnP response"));
      }
    }
  });
}

module.exports = {
  MediaBrowser: MediaBrowser,
  convertInnerDIDL: convertInnerDIDL,
  parseRawDIDLItem: parseRawDIDLItem
}
