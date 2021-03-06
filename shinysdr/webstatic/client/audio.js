// Copyright 2013 Kevin Reid <kpreid@switchb.org>
// 
// This file is part of ShinySDR.
// 
// ShinySDR is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
// 
// ShinySDR is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
// 
// You should have received a copy of the GNU General Public License
// along with ShinySDR.  If not, see <http://www.gnu.org/licenses/>.

define(['./values', './events', './network'], function (values, events, network) {
  'use strict';
  
  var exports = {};
  
  var EMPTY_CHUNK = [];
  
  function connectAudio(url) {
    // TODO portability
    var audio = new webkitAudioContext();
    var sampleRate = audio.sampleRate;
    
    // Queue size management
    // The queue should be large to avoid underruns due to bursty processing/delivery.
    // The queue should be small to minimize latency.
    var targetQueueSize = Math.round(0.2 * sampleRate);
    var queueHistory = new Int32Array(20);
    var queueHistoryPtr = 0;
    
    // Size of data chunks we get from network and the audio context wants, used for tuning our margins
    var inputChunkSizeSample = 0;
    var outputChunkSizeSample = 0;
    
    // Queue of chunks
    var queue = [];
    var queueSampleCount = 0;
    
    // Chunk currently being copied into audio node buffer
    var audioStreamChunk = EMPTY_CHUNK;
    var chunkIndex = 0;
    var prevUnderrun = 0;
    
    // User-facing status display
    // TODO should be faceted read-only when exported
    var errorTime = 0;
    function error(s) {
      info.error._update(String(s));
      errorTime = Date.now() + 1000;
    }
    var info = values.makeBlock({
      buffered: new values.LocalReadCell(new values.Range([[0, 2]], false, false), 0),
      target: new values.LocalReadCell(String, ''),  // TODO should be numeric w/ unit
      error: new values.LocalReadCell(String, ''),
    });
    function updateStatus() {
      var buffered = (queueSampleCount + audioStreamChunk.length - chunkIndex) / sampleRate;
      var target = targetQueueSize / sampleRate;
      info.buffered._update(buffered / target);
      info.target._update(target.toFixed(2) + ' s');
      if (errorTime < Date.now()) {
        info.error._update('');
      }
    }
    
    function updateParameters() {
      // Update queue size management
      queueHistory[queueHistoryPtr] = queueSampleCount;
      queueHistoryPtr = (queueHistoryPtr + 1) % queueHistory.length;
      var least = Math.min.apply(undefined, queueHistory);
      var most = Math.max.apply(undefined, queueHistory);
      targetQueueSize = Math.max(1, Math.round(
        ((most - least) + Math.max(inputChunkSizeSample, outputChunkSizeSample))));
      
      updateStatus();
    }
    
    network.retryingConnection(url + '?rate=' + encodeURIComponent(JSON.stringify(sampleRate)), function (ws) {
      ws.binaryType = 'arraybuffer';
      ws.onmessage = function(event) {
        if (queue.length > 100) {
          console.log('Extreme audio overrun.');
          queue.length = 0;
          queueSampleCount = 0;
          return;
        }
        var chunk;
        if (typeof event.data === 'string') {
          chunk = JSON.parse(event.data);
        } else if (event.data instanceof ArrayBuffer) {
          // TODO think about float format portability (endianness only...?)
          chunk = new Float32Array(event.data);
        } else {
          // TODO handle in general
          console.error('bad WS data');
          ws.close(1003);
          return;
        }
        queue.push(chunk);
        queueSampleCount += chunk.length;
        inputChunkSizeSample = chunk.length;
        updateParameters();
      };
      ws.addEventListener('close', function (event) {
        error('Disconnected.');
        closed();
      });
      setTimeout(opened, 0);
    });
    
    // Choose max buffer size
    var maxDelay = 0.15;
    var maxBufferSize = sampleRate * maxDelay;
    var bufferSize = 1 << Math.floor(Math.log(maxBufferSize) / Math.LN2);
    
    var ascr = audio.createScriptProcessor(bufferSize, 0, 2);
    ascr.onaudioprocess = function audioCallback(event) {
      var abuf = event.outputBuffer;
      outputChunkSizeSample = abuf.length;
      var l = abuf.getChannelData(0);
      var r = abuf.getChannelData(1);
      var j;
      for (j = 0;
           chunkIndex < audioStreamChunk.length && j < abuf.length;
           chunkIndex += 2, j++) {
        l[j] = audioStreamChunk[chunkIndex];
        r[j] = audioStreamChunk[chunkIndex + 1];
      }
      while (j < abuf.length) {
        // Get next chunk
        // TODO: shift() is expensive
        audioStreamChunk = queue.shift() || EMPTY_CHUNK;
        queueSampleCount -= audioStreamChunk.length;
        chunkIndex = 0;
        if (audioStreamChunk.length == 0) {
          break;
        }
        for (;
             chunkIndex < audioStreamChunk.length && j < abuf.length;
             chunkIndex += 2, j++) {
          l[j] = audioStreamChunk[chunkIndex];
          r[j] = audioStreamChunk[chunkIndex + 1];
        }
        if (queueSampleCount > targetQueueSize) {
          var drop = Math.ceil((queueSampleCount - targetQueueSize) / 1024);
          if (drop > 12) {  // ignore small clock-skew-ish amounts of overrun
            error('Overrun; dropping ' + drop + ' samples.');
          }
          j = Math.max(0, j - drop);
        }
      }
      var underrun = abuf.length - j;
      for (; j < abuf.length; j++) {
        // Fill any underrun
        l[j] = 0;
        r[j] = 0;
      }
      if (prevUnderrun != 0 && underrun != bufferSize) {
        // Report underrun, but only if it's not just due to the stream stopping
        error('Underrun by ' + prevUnderrun + ' samples.');
      }
      prevUnderrun = underrun;

      updateParameters();
    };

    // Workaround for Chromium bug https://code.google.com/p/chromium/issues/detail?id=82795 -- ScriptProcessor nodes are not kept live
    window.__dummy_audio_node_reference = ascr;
    //console.log('audio init done');

    function opened() {
      ascr.connect(audio.destination);
    }
    function closed() {
      ascr.disconnect(audio.destination);
    }
    
    return info;
  }
  
  exports.connectAudio = connectAudio;
  
  return Object.freeze(exports);
});