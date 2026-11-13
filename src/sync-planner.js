export const Action = Object.freeze({
  DISPLAY: 'display',
  DROP: 'drop',
  REPEAT: 'repeat',
  DEFER: 'defer',
});

export const Reason = Object.freeze({
  RESYNC_ANCHOR: 'resync-anchor',
  LATE_FIRST_FRAME: 'late-first-frame',
  LONG_GAP_RESYNC: 'long-gap-resync',
  DUPLICATE_TIMESTAMP: 'duplicate-timestamp',
  OUT_OF_ORDER_PTS: 'out-of-order-pts',
  ZERO_DURATION: 'zero-duration',
  LATE_DROP: 'late-drop',
  VIDEO_AHEAD_REPEAT: 'video-ahead-repeat',
  AUDIO_EMPTY_DEFER: 'audio-buffer-empty-defer',
  MAX_LEAD_DEFER: 'max-lead-defer',
  DURATION_CLAMPED: 'duration-clamped',
  IN_TOLERANCE: 'in-tolerance',
});

export const Phase = Object.freeze({
  RESYNC: 'resync',
  LOCKED: 'locked',
});

const MS = 1 / 1000;

const DEFAULTS = Object.freeze({
  sampleRate: 48000,
  refreshRate: 60,
  // |drift| within this window: display the frame as-is.
  syncToleranceMs: 40,
  // Frame later than this behind the audio clock: drop it.
  dropThresholdMs: 120,
  // Max repeats emitted for the previous frame when video runs ahead.
  maxRepeat: 3,
  // Video may never lead the audio clock by more than this; beyond it
  // frames are deferred (critical when the audio buffer is empty).
  maxVideoLeadMs: 250,
  // A pts jump larger than this is a discontinuity and forces resync.
  longGapMs: 1000,
  // Allowed relative deviation of one frame interval from the estimate.
  durationToleranceRatio: 0.5,
});

/**
 * Plans video frame display/drop/repeat decisions against an audio master
 * clock. Fully deterministic: every output is a pure function of the
 * constructor options and the sequence of method calls. No wall clock,
 * no decoding, no rendering.
 */
export class SyncPlanner {
  constructor(options = {}) {
    const opts = { ...DEFAULTS, ...options };
    this.sampleRate = opts.sampleRate;
    this.refreshRate = opts.refreshRate;
    this.syncToleranceSec = opts.syncToleranceMs * MS;
    this.dropThresholdSec = opts.dropThresholdMs * MS;
    this.maxRepeat = opts.maxRepeat;
    this.maxVideoLeadSec = opts.maxVideoLeadMs * MS;
    this.longGapSec = opts.longGapMs * MS;
    this.durationToleranceRatio = opts.durationToleranceRatio;
    this.nominalFrameDurationSec = opts.frameDurationMs != null ? opts.frameDurationMs * MS : null;
    this._lastAudioSec = null;
    this._enterResync('start');
  }

  /** Playback seeked: discard all queued state and resync on next plan(). */
  notifySeek() {
    this._enterResync('seek');
  }

  /** Container/decoder signalled a timestamp discontinuity. */
  notifyDiscontinuity() {
    this._enterResync('discontinuity');
  }

  /** Display refresh rate changed (e.g. moved to a 144 Hz monitor). */
  setRefreshRate(hz) {
    if (!(hz > 0)) throw new RangeError('refreshRate must be positive');
    if (hz !== this.refreshRate) {
      this.refreshRate = hz;
      this._enterResync('refresh-rate-change');
    }
  }

  get phase() {
    return this._phase;
  }

  _enterResync(reason) {
    // Keep the old anchor so the first frame after resync can be
    // classified (e.g. late-first-frame) against the previous mapping.
    this._preResyncAnchor = this._anchor ?? null;
    this._phase = Phase.RESYNC;
    this._resyncReason = reason;
    this._anchor = null;
    this._lastAcceptedPts = null;
    this._lastEffectivePts = null;
    this._lastDisplayed = null;
    // Unknown until the first real frame delta (or an explicit option)
    // seeds it; clamping is disabled while unknown.
    this._estimatedDuration = this.nominalFrameDurationSec;
  }

  _mappedVideoSec(audioSec) {
    return this._anchor.videoSec + (audioSec - this._anchor.audioSec);
  }

  /**
   * Plan one batch.
   * @param {object} input
   * @param {number} input.audioSamplesPlayed total samples consumed by the
   *   audio device since stream start (monotonic, master clock).
   * @param {Array<{pts:number, duration?:number}>} input.frames candidate
   *   frames in decode order, pts in seconds.
   * @param {boolean} [input.audioBufferEmpty] true when the audio buffer
   *   underran and the audio clock is frozen.
   * @returns {{phase:string, audioSec:number, mappedVideoSec:?number, decisions:Array}}
   */
  plan(input) {
    const audioSec = input.audioSamplesPlayed / this.sampleRate;
    const bufferEmpty = input.audioBufferEmpty === true;

    if (
      this._phase === Phase.LOCKED &&
      this._lastAudioSec != null &&
      (audioSec < this._lastAudioSec - 1e-9 ||
        audioSec - this._lastAudioSec > this.longGapSec)
    ) {
      this._enterResync('audio-clock-jump');
    }

    const decisions = [];
    const frames = input.frames ?? [];
    for (let index = 0; index < frames.length; index += 1) {
      const frame = frames[index];

      if (frame.duration !== undefined && !(frame.duration > 0)) {
        decisions.push(this._decision(frame, Action.DROP, Reason.ZERO_DURATION, null));
        continue;
      }
      if (this._lastAcceptedPts != null) {
        if (frame.pts === this._lastAcceptedPts) {
          decisions.push(this._decision(frame, Action.DROP, Reason.DUPLICATE_TIMESTAMP, null));
          continue;
        }
        if (frame.pts < this._lastAcceptedPts) {
          decisions.push(this._decision(frame, Action.DROP, Reason.OUT_OF_ORDER_PTS, null));
          continue;
        }
        if (frame.pts - this._lastAcceptedPts > this.longGapSec) {
          this._enterResync('long-gap');
        }
      }

      if (this._phase === Phase.RESYNC) {
        decisions.push(this._anchorOn(frame, audioSec));
        continue;
      }

      const rawDelta = frame.pts - this._lastAcceptedPts;
      this._updateDurationEstimate(rawDelta);
      const tolerance = this.durationToleranceRatio * this._estimatedDuration;
      const clampedDelta =
        this._estimatedDuration == null
          ? rawDelta
          : Math.min(
              Math.max(rawDelta, this._estimatedDuration - tolerance),
              this._estimatedDuration + tolerance,
            );
      const durationClamped = clampedDelta !== rawDelta;
      const effectivePts = this._lastEffectivePts + clampedDelta;
      const drift = effectivePts - this._mappedVideoSec(audioSec);

      if (drift > this.maxVideoLeadSec) {
        const reason = bufferEmpty ? Reason.AUDIO_EMPTY_DEFER : Reason.MAX_LEAD_DEFER;
        for (let rest = index; rest < frames.length; rest += 1) {
          decisions.push(this._decision(frames[rest], Action.DEFER, reason, drift));
        }
        break;
      }

      if (drift < -this.dropThresholdSec) {
        decisions.push(this._decision(frame, Action.DROP, Reason.LATE_DROP, drift));
        // Dropping skips the frame in the stream, letting the stream
        // catch up to the clock: shift the mapped video position back
        // by its (clamped, predictable) duration.
        this._anchor.videoSec -= clampedDelta;
        this._accept(frame, effectivePts, false);
        continue;
      }

      if (drift > this.syncToleranceSec && this._lastDisplayed != null) {
        const interval = 1 / this.refreshRate;
        const repeats = Math.min(Math.floor(drift / interval), this.maxRepeat);
        for (let r = 0; r < repeats; r += 1) {
          decisions.push(
            this._decision(this._lastDisplayed, Action.REPEAT, Reason.VIDEO_AHEAD_REPEAT, drift),
          );
        }
        // Repeating holds the video stream back while audio advances.
        // Only credit that when the audio clock actually advanced since
        // the last batch; with a frozen clock (buffer underrun) repeats
        // must not buy additional lead.
        const audioAdvanced =
          this._lastAudioSec != null && audioSec > this._lastAudioSec + 1e-9;
        if (repeats > 0 && audioAdvanced && !bufferEmpty) {
          this._anchor.videoSec += repeats * interval;
        }
      }

      decisions.push(
        this._decision(
          frame,
          Action.DISPLAY,
          durationClamped ? Reason.DURATION_CLAMPED : Reason.IN_TOLERANCE,
          drift,
        ),
      );
      this._accept(frame, effectivePts, true);
    }

    this._lastAudioSec = audioSec;
    return {
      phase: this._phase,
      audioSec,
      mappedVideoSec: this._anchor ? this._mappedVideoSec(audioSec) : null,
      decisions,
    };
  }

  _anchorOn(frame, audioSec) {
    // Drift of this frame against the mapping that was in force before the
    // resync (or against a zero-aligned stream start when there was none).
    const expected = this._preResyncAnchor
      ? this._preResyncAnchor.videoSec + (audioSec - this._preResyncAnchor.audioSec)
      : audioSec;
    const preDrift = frame.pts - expected;

    this._anchor = { audioSec, videoSec: frame.pts };
    this._phase = Phase.LOCKED;
    this._accept(frame, frame.pts, true);

    let reason;
    if (this._resyncReason === 'long-gap') {
      reason = Reason.LONG_GAP_RESYNC;
    } else if (preDrift < -this.dropThresholdSec) {
      reason = Reason.LATE_FIRST_FRAME;
    } else {
      reason = Reason.RESYNC_ANCHOR;
    }
    this._preResyncAnchor = null;
    return this._decision(frame, Action.DISPLAY, reason, preDrift);
  }

  _accept(frame, effectivePts, displayed) {
    this._lastAcceptedPts = frame.pts;
    this._lastEffectivePts = effectivePts;
    if (displayed) this._lastDisplayed = frame;
  }

  _updateDurationEstimate(rawDelta) {
    if (rawDelta > 0 && rawDelta <= this.longGapSec) {
      if (this._estimatedDuration == null) {
        this._estimatedDuration = rawDelta;
      } else {
        // EMA; ignores insane deltas.
        this._estimatedDuration = this._estimatedDuration * 0.9 + rawDelta * 0.1;
      }
    }
  }

  _decision(frame, action, reason, driftSec) {
    return {
      pts: frame.pts,
      action,
      reason,
      driftMs: driftSec == null ? null : driftSec / MS,
    };
  }
}
