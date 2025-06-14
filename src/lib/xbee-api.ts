/*
 * xbee-api
 * https://github.com/jouz/xbee-api
 *
 * Copyright (c) 2013 Jan Kolkmeier
 * Licensed under the MIT license.
 */

import * as stream from 'stream';
import { EventMap } from 'typed-emitter';
import { BufferBuilder, BufferReader } from './buffer-tools';
import { FRAME_TYPE as FrameType } from './constants';
import { ChecksumMismatchError, ParseState, UnknownFrameType } from './errors';
import * as C from './constants';
import FrameBuilder, { BuildableFrame } from './frame-builder';
import frame_parser, { ParsableFrame } from './frame-parser';

export type SpecificParsableFrame<FT extends FrameType> = Extract<
  ParsableFrame,
  { type: FT }
>;
export type SpecificBuildableFrame<FT extends FrameType> = Extract<
  BuildableFrame,
  { type: FT }
>;

// can't find a better way to remove the type conflict on listeners & rawListeners
// than redefining the whole interface
interface EmitterWithUntypedListeners<Events extends EventMap> {
  addListener: <E extends keyof Events>(event: E, listener: Events[E]) => this;
  on: <E extends keyof Events>(event: E, listener: Events[E]) => this;
  once: <E extends keyof Events>(event: E, listener: Events[E]) => this;
  prependListener: <E extends keyof Events>(
    event: E,
    listener: Events[E]
  ) => this;
  prependOnceListener: <E extends keyof Events>(
    event: E,
    listener: Events[E]
  ) => this;

  off: <E extends keyof Events>(event: E, listener: Events[E]) => this;
  removeAllListeners: <E extends keyof Events>(event?: E) => this;
  removeListener: <E extends keyof Events>(
    event: E,
    listener: Events[E]
  ) => this;

  emit: <E extends keyof Events>(
    event: E,
    ...args: Parameters<Events[E]>
  ) => boolean;
  // The sloppy `eventNames()` return type is to mitigate type incompatibilities - see #5
  eventNames: () => Array<keyof Events | string | symbol>;
  listenerCount: <E extends keyof Events>(event: E) => number;

  getMaxListeners: () => number;
  setMaxListeners: (maxListeners: number) => this;
}

export interface XBeeAPIOptions {
  /** 1 is default, 2 is with escaping (set ATAP=2) */
  api_mode: 1 | 2;
  /** if set to true, only raw byte frames are emitted (after validation) but not parsed to objects. */
  raw_frames: boolean;
  /**
   * when null or undefined, do not convert adc value to millivolts.
   *
   * when a number, use this as the reference voltage (in mV) for adc conversion.
   */
  vref_adc: number | null | undefined;
}

const DEFAULT_OPTIONS: XBeeAPIOptions = {
  raw_frames: false,
  api_mode: 1,
  vref_adc: 1200,
};

const BUFFER_SIZE = 512;

/**
 * Stream that takes Buffers and outputs ParsableFrames. Or, if `options.raw_frames` is true,
 * Buffers that contain exactly one frame's worth of data.
 *
 * @example
 *  const serialport = new SerialPort({ ... });
 *  const parser = serialport.pipe(new XBeeParser());
 *  parser.on("data", (frame) => { ... });
 *  parser.on("error", (err) => { ... });  // ChecksumMismatchError | UnknownFrameType
 */
export class XBeeParser
  extends stream.Transform
  implements
    EmitterWithUntypedListeners<{
      error: (err: ChecksumMismatchError | UnknownFrameType) => void;
      data: (frame: ParsableFrame | Uint8Array) => void;
    }>
{
  readonly _options: XBeeAPIOptions;

  constructor(options: Partial<XBeeAPIOptions> = {}) {
    super({
      objectMode: true,
    });
    this._options = { ...DEFAULT_OPTIONS, ...options };
  }

  static frameType(buffer: Uint8Array): FrameType | number {
    return buffer[3];
  }

  static canParse(buffer: Uint8Array): boolean {
    const type = XBeeParser.frameType(buffer);
    return type in frame_parser;
  }

  // Note that this expects the whole frame to be escaped!
  static parseFrame(
    rawFrame: Uint8Array,
    options: XBeeAPIOptions
  ): ParsableFrame {
    // Trim the header and trailing checksum
    const reader = new BufferReader(rawFrame.subarray(3, rawFrame.length - 1));

    const frame = {
      type: reader.nextUInt8(), // Read Frame Type
    };
    if (!(frame.type in frame_parser)) {
      throw new UnknownFrameType(frame.type);
    } else {
      // @ts-expect-error  can't be bothered to fix this right now, but the logic is sound
      frame_parser[frame.type](frame, reader, options);
    }

    // Frame type specific parsing.

    return frame as unknown as ParsableFrame;
  }

  private readonly parseState: ParseState = {
    buffer: new Uint8Array(BUFFER_SIZE),
    offset: 0,
    length: 0,
    total: 0,
    checksum: 0x00,
    b: 0x00,
    escape_next: false,
    waiting: true,
  };

  _transform(
    buffer: Uint8Array,
    encoding: BufferEncoding,
    cb: stream.TransformCallback
  ): void {
    const S = this.parseState;
    for (let i = 0; i < buffer.length; i++) {
      S.b = buffer[i];
      if (
        (S.waiting || (this._options.api_mode === 2 && !S.escape_next)) &&
        S.b === C.START_BYTE
      ) {
        S.buffer = new Uint8Array(BUFFER_SIZE);
        S.length = 0;
        S.total = 0;
        S.checksum = 0x00;
        S.offset = 0;
        S.escape_next = false;
        S.waiting = false;
      }

      if (this._options.api_mode === 2 && S.b === C.ESCAPE) {
        S.escape_next = true;
        continue;
      }

      if (S.escape_next) {
        S.b = 0x20 ^ S.b;
        S.escape_next = false;
      }

      if (!S.waiting) {
        if (S.buffer.length > S.offset) {
          S.buffer[S.offset++] = S.b;
        } else {
          console.assert(false, 'Buffer overrun');
          S.waiting = true;
        }
      }

      if (S.offset === 1) {
        continue;
      }

      if (S.offset === 2) {
        S.length = S.b << 8; // most sign. bit of the length
        continue;
      }
      if (S.offset === 3) {
        S.length += S.b; // least sign. bit of the length
        continue;
      }

      if (S.offset > 3) {
        // unnessary check
        if (S.offset < S.length + 4) {
          S.total += S.b;
          continue;
        } else {
          S.checksum = S.b;
        }
      }

      if (S.length > 0 && S.offset === S.length + 4) {
        const actualChecksum = 0xff - (S.total % 0x100);
        if (S.checksum !== actualChecksum) {
          console.warn("Checksum mismatch:", S.checksum, actualChecksum);
          //this.emit('error', new ChecksumMismatchError(S, actualChecksum));
        } else {
          console.log("Checksum verification success!");
        }

        const rawFrame = S.buffer.subarray(0, S.offset);
        if (this._options.raw_frames) {
          this.push(rawFrame);
        } else {
          if (!XBeeParser.canParse(rawFrame)) {
            this.emit(
              'error',
              new UnknownFrameType(XBeeParser.frameType(rawFrame))
            );
          } else {
            try {
              const frame: ParsableFrame = XBeeParser.parseFrame(
                rawFrame,
                this._options
              );
              this.push(frame);
            } catch (err) {
              this.emit('error', err);
            }
          }
        }

        // Reset some things so we don't try to reeimt the same package if there is more (bogus?) data
        S.waiting = true;
        S.length = 0;
      }
    }
    cb();
  }
}

/**
 * Stream that takes BuildableFrames and outputs Buffers.
 *
 * @example
 *   const builder = new XBeeBuilder();
 *   const serialport = new SerialPort({ ... });
 *   builder.pipe(serialport);
 *   builder.write({ type: C.FRAME_TYPE.AT_COMMAND, command: "NI" });
 */
export class XBeeBuilder
  extends stream.Transform
  implements
    EmitterWithUntypedListeners<{
      error: (err: UnknownFrameType) => void;
      data: (frame: Uint8Array) => void;
    }>
{
  _options: XBeeAPIOptions;
  private readonly frameBuilder: FrameBuilder = FrameBuilder();

  constructor(options: Partial<XBeeAPIOptions> = {}) {
    super({
      objectMode: true,
    });
    this._options = {
      ...DEFAULT_OPTIONS,
      ...options,
    };
  }

  /**
   * Builds a new frame from the given frame and options.
   *
   * Note: if you're calling this manually, you will need to define a frame id on your frame
   * manually, or you will receive a default frame id of 0.
   *
   * @param frame
   * @param options XBeeApiOptions: only api_mode is used
   * @param frameBuilder leave unset--internal use only
   */
  static buildFrame(
    frame: BuildableFrame,
    options: {
      api_mode: 1 | 2;
    } = { api_mode: 1 },
    frameBuilder = FrameBuilder()
  ): Uint8Array {
    let packet = new Uint8Array(BUFFER_SIZE); // Packet buffer
    let payload = packet.subarray(3); // Reference the buffer past the header
    let builder = new BufferBuilder(payload);

    if (!(frame.type in frameBuilder)) {
      throw new UnknownFrameType(frame.type);
    }

    // Let the builder fill the payload
    frameBuilder[frame.type](frame as any, builder);

    // Calculate & Append Checksum
    let checksum = 0;
    for (let i = 0; i < builder.length; i++) checksum += payload[i];
    builder.appendUInt8(255 - (checksum % 256));

    // Get just the payload
    payload = payload.subarray(0, builder.length);

    // Build the header at the start of the packet buffer
    builder = new BufferBuilder(packet);
    builder.appendUInt8(C.START_BYTE);
    builder.appendUInt16BE(payload.length - 1); // Sans checksum

    // Get the header and payload as one contiguous buffer
    packet = packet.subarray(0, (builder.length as number) + payload.length);

    // Escape the packet, if needed
    return options.api_mode === 2 ? XBeeBuilder.escape(packet) : packet;
  }

  _transform(
    frame: BuildableFrame,
    encoding: BufferEncoding,
    cb: stream.TransformCallback
  ): void {
    try {
      const packet = XBeeBuilder.buildFrame(
        frame,
        this._options,
        this.frameBuilder
      );
      this.push(packet);
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }

  private static escape(buffer: Uint8Array): Uint8Array {
    const escapeBuffer = new Uint8Array(buffer.length * 2);

    let offset = 0;
    escapeBuffer[offset++] = buffer[0];
    for (let i = 1; i < buffer.length; i++) {
      if (C.ESCAPE_BYTES.includes(buffer[i])) {
        escapeBuffer[offset++] = C.ESCAPE;
        escapeBuffer[offset++] = buffer[i] ^ C.ESCAPE_WITH;
      } else {
        escapeBuffer[offset++] = buffer[i];
      }
    }

    return buffer.subarray(0, offset);
  }

  /** Returns true if the frame type is supported by the builder. */
  static canBuild(type: FrameType): boolean {
    return type in FrameBuilder();
  }

  /**
   * Returns the next frame id, incrementing the internal counter. This can be used to
   * generate frame ids, which can then be used to match requests with responses.
   */
  nextFrameId(): number {
    return this.frameBuilder.nextFrameId();
  }
}
