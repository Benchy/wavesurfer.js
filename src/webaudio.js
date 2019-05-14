import * as util from './util';

// using constants to prevent someone writing the string wrong
const PLAYING = 'playing';
const PAUSED = 'paused';
const FINISHED = 'finished';

/**
 * WebAudio backend
 *
 * @extends {Observer}
 */
export default class WebAudio extends util.Observer {
    /** @private */
    static scriptBufferSize = 256;
    /** @private */
    audioContext = null;
    /** @private */
    offlineAudioContext = null;
    /** @private */
    stateBehaviors = {
        [PLAYING]: {
            init() {
                this.addOnAudioProcess();
            },
            getPlayedPercents() {
                const duration = this.getDuration();
                return this.getCurrentTime() / duration || 0;
            },
            getCurrentTime() {
                return this.startPosition + this.getPlayedTime();
            }
        },
        [PAUSED]: {
            init() {
                this.removeOnAudioProcess();
            },
            getPlayedPercents() {
                const duration = this.getDuration();
                return this.getCurrentTime() / duration || 0;
            },
            getCurrentTime() {
                return this.startPosition;
            }
        },
        [FINISHED]: {
            init() {
                this.removeOnAudioProcess();
                this.fireEvent('finish');
            },
            getPlayedPercents() {
                return 1;
            },
            getCurrentTime() {
                return this.getDuration();
            }
        }
    };

    /**
     * Does the browser support this backend
     *
     * @return {boolean} Whether or not this browser supports this backend
     */
    supportsWebAudio() {
        return !!(window.AudioContext || window.webkitAudioContext);
    }

    /**
     * Get the audio context used by this backend or create one
     *
     * @return {AudioContext} Existing audio context, or creates a new one
     */
    getAudioContext() {
        if (!window.WaveSurferAudioContext) {
            window.WaveSurferAudioContext = new (window.AudioContext ||
                window.webkitAudioContext)();
        }
        return window.WaveSurferAudioContext;
    }

    /**
     * Get the offline audio context used by this backend or create one
     *
     * @param {number} sampleRate The sample rate to use
     * @return {OfflineAudioContext} Existing offline audio context, or creates
     * a new one
     */
    getOfflineAudioContext(sampleRate) {
        if (!window.WaveSurferOfflineAudioContext) {
            window.WaveSurferOfflineAudioContext = new (window.OfflineAudioContext ||
                window.webkitOfflineAudioContext)(1, 2, sampleRate);
        }
        return window.WaveSurferOfflineAudioContext;
    }

    /**
     * Construct the backend
     *
     * @param {WavesurferParams} params Wavesurfer parameters
     */
    constructor(params) {
        super();
        /** @private */
        this.params = params;
        /** @private */
        this.ac =
            params.audioContext ||
            (this.supportsWebAudio() ? this.getAudioContext() : {});
        /**@private */
        this.lastPlay = this.ac.currentTime;
        /** @private */
        this.startPosition = 0;
        /** @private  */
        this.scheduledPause = null;
        /** @private */
        this.states = {
            [PLAYING]: Object.create(this.stateBehaviors[PLAYING]),
            [PAUSED]: Object.create(this.stateBehaviors[PAUSED]),
            [FINISHED]: Object.create(this.stateBehaviors[FINISHED])
        };
        /** @private */
        this.analyser = null;
        /** @private */
        this.buffer = null;
        /** @private */
        this.filters = [];
        /** @private */
        this.gainNode = null;
        /** @private */
        this.mergedPeaks = null;
        /** @private */
        this.offlineAc = null;
        /** @private */
        this.peaks = null;
        /** @private */
        this.playbackRate = 1;
        /** @private */
        this.analyser = null;
        /** @private */
        this.scriptNode = null;
        /** @private */
        this.source = null;
        /** @private */
        this.splitPeaks = [];
        /** @private */
        this.state = null;
        /** @private */
        this.explicitDuration = params.duration;

        // AIRFIX SPECIFIC CODE
        /** @private */
        this.tempBuffer = null;
        this.tempAnalyser = null;
        this.isCrossfading = false;
        this.crossFadeProgress = 0;
        this.tempSource = null;
        this.crossFadeAudioProcessCallback = null;
    }

    /**
     * Initialise the backend, called in `wavesurfer.createBackend()`
     */
    init() {
        this.createVolumeNode();
        this.createScriptNode();
        this.createAnalyserNode();

        this.setState(PAUSED);
        this.setPlaybackRate(this.params.audioRate);
        this.setLength(0);
    }

    /** @private */
    disconnectFilters() {
        if (this.filters) {
            this.filters.forEach(filter => {
                filter && filter.disconnect();
            });
            this.filters = null;
            // Reconnect direct path
            this.analyser.connect(this.gainNode);
        }
    }

    /**
     * @private
     *
     * @param {string} state The new state
     */
    setState(state) {
        if (this.state !== this.states[state]) {
            this.state = this.states[state];
            this.state.init.call(this);
        }
    }

    /**
     * Unpacked `setFilters()`
     *
     * @param {...AudioNode} filters One or more filters to set
     */
    setFilter(...filters) {
        this.setFilters(filters);
    }

    /**
     * Insert custom Web Audio nodes into the graph
     *
     * @param {AudioNode[]} filters Packed filters array
     * @example
     * const lowpass = wavesurfer.backend.ac.createBiquadFilter();
     * wavesurfer.backend.setFilter(lowpass);
     */
    setFilters(filters) {
        // Remove existing filters
        this.disconnectFilters();

        // Insert filters if filter array not empty
        if (filters && filters.length) {
            this.filters = filters;

            // Disconnect direct path before inserting filters
            this.analyser.disconnect();

            // Connect each filter in turn
            filters
                .reduce((prev, curr) => {
                    prev.connect(curr);
                    return curr;
                }, this.analyser)
                .connect(this.gainNode);
        }
    }

    /** @private */
    createScriptNode() {
        if (this.params.audioScriptProcessor) {
            this.scriptNode = this.params.audioScriptProcessor;
        } else {
            if (this.ac.createScriptProcessor) {
                this.scriptNode = this.ac.createScriptProcessor(
                    WebAudio.scriptBufferSize
                );
            } else {
                this.scriptNode = this.ac.createJavaScriptNode(
                    WebAudio.scriptBufferSize
                );
            }
        }
        this.scriptNode.connect(this.ac.destination);
    }

    /** @private */
    addOnAudioProcess() {
        this.scriptNode.onaudioprocess = () => {
            const time = this.getCurrentTime();

            if (time >= this.getDuration()) {
                this.setState(FINISHED);
                this.fireEvent('pause');
            } else if (time >= this.scheduledPause) {
                this.pause();
            } else if (this.state === this.states[PLAYING]) {
                this.fireEvent('audioprocess', time);
            }
        };
    }

    /** @private */
    removeOnAudioProcess() {
        this.scriptNode.onaudioprocess = () => {};
    }

    /** @private */
    createAnalyserNode() {
        this.analyser = this.ac.createAnalyser();
        this.analyser.connect(this.gainNode);
    }

    /**
     * Create the gain node needed to control the playback volume.
     *
     * @private
     */
    createVolumeNode() {
        // Create gain node using the AudioContext
        if (this.ac.createGain) {
            this.gainNode = this.ac.createGain();
        } else {
            this.gainNode = this.ac.createGainNode();
        }
        // Add the gain node to the graph
        this.gainNode.connect(this.ac.destination);
    }

    /**
     * Set the sink id for the media player
     *
     * @param {string} deviceId String value representing audio device id.
     * @returns {Promise} A Promise that resolves to `undefined` when there
     * are no errors.
     */
    setSinkId(deviceId) {
        if (deviceId) {
            /**
             * The webaudio API doesn't currently support setting the device
             * output. Here we create an HTMLAudioElement, connect the
             * webaudio stream to that element and setSinkId there.
             */
            let audio = new window.Audio();
            if (!audio.setSinkId) {
                return Promise.reject(
                    new Error('setSinkId is not supported in your browser')
                );
            }
            audio.autoplay = true;
            var dest = this.ac.createMediaStreamDestination();
            this.gainNode.disconnect();
            this.gainNode.connect(dest);
            audio.srcObject = dest.stream;

            return audio.setSinkId(deviceId);
        } else {
            return Promise.reject(new Error('Invalid deviceId: ' + deviceId));
        }
    }

    /**
     * Set the audio volume
     *
     * @param {number} value A floating point value between 0 and 1.
     */
    setVolume(value) {
        this.gainNode.gain.setValueAtTime(value, this.ac.currentTime);
    }

    /**
     * Get the current volume
     *
     * @return {number} value A floating point value between 0 and 1.
     */
    getVolume() {
        return this.gainNode.gain.value;
    }

    /**
     * Decode an array buffer and pass data to a callback
     *
     * @private
     * @param {ArrayBuffer} arraybuffer The array buffer to decode
     * @param {function} callback The function to call on complete.
     * @param {function} errback The function to call on error.
     */
    decodeArrayBuffer(arraybuffer, callback, errback) {
        if (!this.offlineAc) {
            this.offlineAc = this.getOfflineAudioContext(
                this.ac && this.ac.sampleRate ? this.ac.sampleRate : 44100
            );
        }
        this.offlineAc.decodeAudioData(
            arraybuffer,
            data => callback(data),
            errback
        );
    }

    /**
     * Set pre-decoded peaks
     *
     * @param {number[]|Number.<Array[]>} peaks Peaks data
     * @param {?number} duration Explicit duration
     */
    setPeaks(peaks, duration) {
        if (duration != null) {
            this.explicitDuration = duration;
        }
        this.peaks = peaks;
    }

    /**
     * Set the rendered length (different from the length of the audio)
     *
     * @param {number} length The rendered length
     */
    setLength(length) {
        // No resize, we can preserve the cached peaks.
        if (this.mergedPeaks && length == 2 * this.mergedPeaks.length - 1 + 2) {
            return;
        }

        this.splitPeaks = [];
        this.mergedPeaks = [];
        // Set the last element of the sparse array so the peak arrays are
        // appropriately sized for other calculations.
        const channels = this.buffer ? this.buffer.numberOfChannels : 1;
        let c;
        for (c = 0; c < channels; c++) {
            this.splitPeaks[c] = [];
            this.splitPeaks[c][2 * (length - 1)] = 0;
            this.splitPeaks[c][2 * (length - 1) + 1] = 0;
        }
        this.mergedPeaks[2 * (length - 1)] = 0;
        this.mergedPeaks[2 * (length - 1) + 1] = 0;
    }

    /**
     * Compute the max and min value of the waveform when broken into <length> subranges.
     *
     * @param {number} length How many subranges to break the waveform into.
     * @param {number} first First sample in the required range.
     * @param {number} last Last sample in the required range.
     * @return {number[]|Number.<Array[]>} Array of 2*<length> peaks or array of arrays of
     * peaks consisting of (max, min) values for each subrange.
     */
    getPeaks(length, first, last) {
        if (this.peaks) {
            return this.peaks;
        }
        if (!this.buffer) {
            return [];
        }

        first = first || 0;
        last = last || length - 1;

        this.setLength(length);

        if (!this.buffer) {
            return this.params.splitChannels
                ? this.splitPeaks
                : this.mergedPeaks;
        }

        /**
         * The following snippet fixes a buffering data issue on the Safari
         * browser which returned undefined It creates the missing buffer based
         * on 1 channel, 4096 samples and the sampleRate from the current
         * webaudio context 4096 samples seemed to be the best fit for rendering
         * will review this code once a stable version of Safari TP is out
         */
        if (!this.buffer.length) {
            const newBuffer = this.createBuffer(1, 4096, this.sampleRate);
            this.buffer = newBuffer.buffer;
        }

        const sampleSize = this.buffer.length / length;
        const sampleStep = ~~(sampleSize / 10) || 1;
        const channels = this.buffer.numberOfChannels;
        let c;
        let crossFadeInProgress = this.isCrossfading && this.tempBuffer;

        for (c = 0; c < channels; c++) {
            const peaks = this.splitPeaks[c];
            const chan = this.buffer.getChannelData(c);
            let chanTemp = undefined;
            if (crossFadeInProgress) {
                chanTemp = this.tempBuffer.getChannelData(c);
            }

            let i;

            for (i = first; i <= last; i++) {
                // get start and end of current sample
                // the sample is a subdivision of the buffer's data
                const start = ~~(i * sampleSize);
                const end = ~~(start + sampleSize);
                let min = 0;
                let max = 0;
                let j;

                // get min and max value for current sample
                for (j = start; j < end; j += sampleStep) {
                    let value = chan[j];

                    if (crossFadeInProgress) {
                        const tempValue = chanTemp[j];
                        value =
                            value +
                            (tempValue - value) * this.crossFadeProgress;
                    }

                    if (value > max) {
                        max = value;
                    }

                    if (value < min) {
                        min = value;
                    }
                }

                // peaks are stored in a single dimension array, but in pairs [max, min]
                peaks[2 * i] = max;
                peaks[2 * i + 1] = min;

                // put the biggest value in mergedpeaks
                if (c == 0 || max > this.mergedPeaks[2 * i]) {
                    this.mergedPeaks[2 * i] = max;
                }

                if (c == 0 || min < this.mergedPeaks[2 * i + 1]) {
                    this.mergedPeaks[2 * i + 1] = min;
                }
            }
        }

        return this.params.splitChannels ? this.splitPeaks : this.mergedPeaks;
    }

    /**
     * Get the position from 0 to 1
     *
     * @return {number} Position
     */
    getPlayedPercents() {
        return this.state.getPlayedPercents.call(this);
    }

    /** @private */
    disconnectSource() {
        if (this.source) {
            this.source.disconnect();
        }
    }

    /**
     * This is called when wavesurfer is destroyed
     */
    destroy() {
        if (!this.isPaused()) {
            this.pause();
        }
        this.unAll();
        this.buffer = null;
        this.disconnectFilters();
        this.disconnectSource();
        this.gainNode.disconnect();
        this.scriptNode.disconnect();
        this.analyser.disconnect();

        // AIRFIX SPECIFIC CODE
        this.disconnectAllTempNodes();
        this.tempBuffer = null;
        this.tempSource = null;
        this.tempGainNode = null;
        this.tempAnalyser = null;
        this.crossFadeAudioProcessCallback = null;

        // close the audioContext if closeAudioContext option is set to true
        if (this.params.closeAudioContext) {
            // check if browser supports AudioContext.close()
            if (
                typeof this.ac.close === 'function' &&
                this.ac.state != 'closed'
            ) {
                this.ac.close();
            }
            // clear the reference to the audiocontext
            this.ac = null;
            // clear the actual audiocontext, either passed as param or the
            // global singleton
            if (!this.params.audioContext) {
                window.WaveSurferAudioContext = null;
            } else {
                this.params.audioContext = null;
            }
            // clear the offlineAudioContext
            window.WaveSurferOfflineAudioContext = null;
        }
    }

    /**
     * Loaded a decoded audio buffer
     *
     * @param {Object} buffer Decoded audio buffer to load
     */
    load(buffer) {
        this.startPosition = 0;
        this.lastPlay = this.ac.currentTime;
        this.buffer = buffer;
        this.createSource();
    }

    /** @private */
    createSource() {
        this.disconnectSource();
        this.source = this.ac.createBufferSource();

        // adjust for old browsers
        this.source.start = this.source.start || this.source.noteGrainOn;
        this.source.stop = this.source.stop || this.source.noteOff;

        this.source.playbackRate.setValueAtTime(
            this.playbackRate,
            this.ac.currentTime
        );
        this.source.buffer = this.buffer;
        this.source.connect(this.analyser);
    }

    /**
     * Used by `wavesurfer.isPlaying()` and `wavesurfer.playPause()`
     *
     * @return {boolean} Whether or not this backend is currently paused
     */
    isPaused() {
        return this.state !== this.states[PLAYING];
    }

    /**
     * Used by `wavesurfer.getDuration()`
     *
     * @return {number} Duration of loaded buffer
     */
    getDuration() {
        if (this.explicitDuration) {
            return this.explicitDuration;
        }
        if (!this.buffer) {
            return 0;
        }
        return this.buffer.duration;
    }

    /**
     * Used by `wavesurfer.seekTo()`
     *
     * @param {number} start Position to start at in seconds
     * @param {number} end Position to end at in seconds
     * @return {{start: number, end: number}} Object containing start and end
     * positions
     */
    seekTo(start, end) {
        if (!this.buffer) {
            return;
        }

        this.scheduledPause = null;

        if (start == null) {
            start = this.getCurrentTime();
            if (start >= this.getDuration()) {
                start = 0;
            }
        }
        if (end == null) {
            end = this.getDuration();
        }

        this.startPosition = start;
        this.lastPlay = this.ac.currentTime;

        if (this.state === this.states[FINISHED]) {
            this.setState(PAUSED);
        }

        return {
            start: start,
            end: end
        };
    }

    /**
     * Get the playback position in seconds
     *
     * @return {number} The playback position in seconds
     */
    getPlayedTime() {
        return (this.ac.currentTime - this.lastPlay) * this.playbackRate;
    }

    /**
     * Plays the loaded audio region.
     *
     * @param {number} start Start offset in seconds, relative to the beginning
     * of a clip.
     * @param {number} end When to stop relative to the beginning of a clip.
     */
    play(start, end) {
        if (!this.buffer) {
            return;
        }

        // need to re-create source on each playback
        this.createSource();
        if (this.isCrossfading) {
            this.createSourceForTempBuffer();
        }

        const adjustedTime = this.seekTo(start, end);

        start = adjustedTime.start;
        end = adjustedTime.end;

        this.scheduledPause = end;

        this.source.start(0, start, end - start);
        if (this.isCrossfading) {
            this.tempSource.start(0, start, end - start);
        }

        if (this.ac.state == 'suspended') {
            this.ac.resume && this.ac.resume();
        }

        this.setState(PLAYING);

        this.fireEvent('play');
    }

    /**
     * Pauses the loaded audio.
     */
    pause() {
        this.scheduledPause = null;

        this.startPosition += this.getPlayedTime();
        this.source && this.source.stop(0);
        if (this.isCrossfading) {
            this.tempSource.stop(0);
        }

        this.setState(PAUSED);

        this.fireEvent('pause');
    }

    /**
     * Returns the current time in seconds relative to the audio-clip's
     * duration.
     *
     * @return {number} The current time in seconds
     */
    getCurrentTime() {
        return this.state.getCurrentTime.call(this);
    }

    /**
     * Returns the current playback rate. (0=no playback, 1=normal playback)
     *
     * @return {number} The current playback rate
     */
    getPlaybackRate() {
        return this.playbackRate;
    }

    /**
     * Set the audio source playback rate.
     *
     * @param {number} value The playback rate to use
     */
    setPlaybackRate(value) {
        value = value || 1;
        if (this.isPaused()) {
            this.playbackRate = value;
        } else {
            this.pause();
            this.playbackRate = value;
            this.play();
        }
    }

    // AIRFIX SPECIFIC CODE STARTS
    /**
     * Plays the loaded audio region.
     *
     * @param {number} start Start offset in seconds, relative to the beginning
     * of a clip.
     * @param {number} end When to stop relative to the beginning of a clip.
     */
    playTempBuffer(start) {
        if (!this.tempBuffer) {
            return;
        }

        // need to re-create source on each playback
        this.createSourceForTempBuffer();

        // seek and start
        this.tempSource.start(0, start);

        if (this.isPaused()) this.tempSource.stop();
    }

    crossFadeBuffers(crossfadeTime) {
        this.isCrossfading = true;
        this.crossFadeProgress = 0;
        this.crossFadePreviousTick = this.getCurrentTime();
        this.playTempBuffer(this.getCurrentTime());

        let preCrossFadeVolume = this.getVolume();
        const self = this;

        this.crossFadeAudioProcessCallback = time =>
            self.crossFadeAudioProcess(
                time,
                crossfadeTime,
                preCrossFadeVolume,
                self
            );
        this.on('audioprocess', this.crossFadeAudioProcessCallback);
    }

    crossFadeAudioProcess(time, crossfadeTime, preCrossFadeVolume, self) {
        if (self.crossFadeProgress >= 1) {
            // unsub from audioProcess and retarget all "temp" nodes and variable to the main one and
            // delete the old "main" branch and variable
            self.un('audioprocess', self.crossFadeAudioProcessCallback);
            self.source.stop(0);

            self.buffer = self.tempBuffer;
            self.tempBuffer = null;

            self.source = self.tempSource;
            self.tempSource = null;

            self.analyser = self.tempAnalyser;
            self.tempAnalyser = null;

            self.gainNode = self.tempGainNode;
            self.tempGainNode = null;

            self.isCrossfading = false;
            this.fireEvent('crossFadeEnd');
            return;
        }

        if (time < self.crossFadePreviousTick) {
            self.crossFadePreviousTick = time;
            return;
        }

        self.crossFadeProgress += (time - self.crossFadePreviousTick) / crossfadeTime;
        if (self.crossFadeProgress > 1.0)
            self.crossFadeProgress = 1.0;

        let mainSourceVolume =
            (1 - self.crossFadeProgress) * preCrossFadeVolume;
        let tempSourceVolume = self.crossFadeProgress * preCrossFadeVolume;

        self.gainNode.gain.setValueAtTime(
            mainSourceVolume,
            self.ac.currentTime
        );
        self.tempGainNode.gain.setValueAtTime(
            tempSourceVolume,
            self.ac.currentTime
        );

        self.crossFadePreviousTick = time;
    }

    loadTempBuffer(buffer) {
        // remove old nodes
        this.disconnectAllTempNodes();

        //create new temp branch
        this.createTempVolumeNode();
        this.createTempAnalyserNode();

        this.tempBuffer = buffer;

        this.createSourceForTempBuffer();
    }

    disconnectAllTempNodes() {
        if (this.tempGainNode) this.tempGainNode.disconnect();

        if (this.tempAnalyser) this.tempAnalyser.disconnect();

        if (this.tempSource) this.tempSource.disconnect();
    }

    disconnectTempSource() {
        if (this.tempSource) {
            this.tempSource.disconnect();
        }
    }

    createTempVolumeNode() {
        // Create gain node using the AudioContext
        if (this.ac.createGain) {
            this.tempGainNode = this.ac.createGain();
        } else {
            this.tempGainNode = this.ac.createGainNode();
        }

        this.tempGainNode.gain.setValueAtTime(0, this.ac.currentTime);

        // Add the gain node to the graph
        this.tempGainNode.connect(this.ac.destination);
    }

    createTempAnalyserNode() {
        this.tempAnalyser = this.ac.createAnalyser();
        this.tempAnalyser.connect(this.tempGainNode);
    }

    createSourceForTempBuffer() {
        this.disconnectTempSource();
        this.tempSource = this.ac.createBufferSource();

        // adjust for old browsers
        // this.tempSource.start = this.source.start || this.source.noteGrainOn;
        // this.tempSource.stop = this.source.stop || this.source.noteOff;
        this.tempSource.playbackRate.setValueAtTime(
            this.playbackRate,
            this.ac.currentTime
        );
        this.tempSource.buffer = this.tempBuffer;
        this.tempSource.connect(this.tempAnalyser);
    }
    // AIRFIX SPECIFIC CODE ENDS
}
