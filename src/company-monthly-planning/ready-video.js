"use strict";

const fs = require("node:fs");

const MAX_VIDEO_BYTES = 100000000;
const MAX_HEADER_BYTES = 16 * 1024 * 1024;

function invalid() {
  const error = new Error("O MP4 final precisa ser vertical, H.264/AAC e ter de 3 a 60 segundos.");
  error.code = "monthly_planning_video_invalid";
  error.statusCode = 422;
  throw error;
}

function boxes(bytes, from, to) {
  const found = [];
  let offset = from;
  while (offset + 8 <= to) {
    if (found.length >= 256) invalid();
    let size = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > to) invalid();
      const wide = bytes.readBigUInt64BE(offset + 8);
      if (wide > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
      size = Number(wide); header = 16;
    } else if (size === 0) size = to - offset;
    if (size < header || offset + size > to || !/^[a-zA-Z0-9 ]{4}$/.test(type)) invalid();
    found.push({ type, start: offset + header, end: offset + size });
    offset += size;
  }
  if (offset !== to) invalid();
  return found;
}

function one(list, type) {
  const found = list.filter(box => box.type === type);
  if (found.length !== 1) invalid();
  return found[0];
}

function children(bytes, parent) { return boxes(bytes, parent.start, parent.end); }

function videoMetadata(bytes) {
  const top = boxes(bytes, 0, bytes.length);
  const ftyp = one(top, "ftyp"), moov = one(top, "moov");
  if (top[0] !== ftyp || ftyp.end - ftyp.start < 8 || moov.end > MAX_HEADER_BYTES ||
      !/^(?:isom|iso[2-9]|mp4[12]|avc1)$/.test(bytes.toString("ascii", ftyp.start, ftyp.start + 4))) invalid();
  const movie = children(bytes, moov), mvhd = one(movie, "mvhd");
  const version = bytes[mvhd.start], scaleAt = mvhd.start + (version === 1 ? 20 : 12);
  const durationAt = scaleAt + 4;
  if (![0, 1].includes(version) || durationAt + (version === 1 ? 8 : 4) > mvhd.end) invalid();
  const scale = bytes.readUInt32BE(scaleAt);
  const duration = version === 1 ? Number(bytes.readBigUInt64BE(durationAt)) : bytes.readUInt32BE(durationAt);
  const durationSeconds = duration / scale;
  if (!scale || !Number.isFinite(durationSeconds) || durationSeconds < 3 || durationSeconds > 60) invalid();
  const tracks = movie.filter(box => box.type === "trak");
  if (tracks.length < 1 || tracks.length > 2) invalid();
  let video = null, audio = null;
  for (const trak of tracks) {
    const parts = children(bytes, trak), tkhd = one(parts, "tkhd");
    const mdia = children(bytes, one(parts, "mdia"));
    const hdlr = one(mdia, "hdlr");
    if (hdlr.start + 12 > hdlr.end) invalid();
    const handler = bytes.toString("ascii", hdlr.start + 8, hdlr.start + 12);
    const stbl = children(bytes, one(children(bytes, one(mdia, "minf")), "stbl"));
    const stsd = one(stbl, "stsd");
    if (stsd.start + 16 > stsd.end || bytes.readUInt32BE(stsd.start + 4) !== 1) invalid();
    const entry = boxes(bytes, stsd.start + 8, stsd.end);
    if (entry.length !== 1) invalid();
    if (handler === "vide") {
      if (video || entry[0].type !== "avc1" || ![0, 1].includes(bytes[tkhd.start])) invalid();
      const geometryAt = tkhd.start + (bytes[tkhd.start] === 1 ? 88 : 76);
      const matrixAt = geometryAt - 36;
      const identity = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];
      if (geometryAt + 8 > tkhd.end || identity.some((value, index) => bytes.readUInt32BE(matrixAt + index * 4) !== value) ||
          entry[0].start + 28 > entry[0].end) invalid();
      video = { width: bytes.readUInt32BE(geometryAt) >>> 16, height: bytes.readUInt32BE(geometryAt + 4) >>> 16 };
      if (bytes.readUInt16BE(entry[0].start + 24) !== video.width ||
          bytes.readUInt16BE(entry[0].start + 26) !== video.height) invalid();
    } else if (handler === "soun") {
      if (audio || entry[0].type !== "mp4a") invalid();
      audio = true;
    } else invalid();
  }
  if (!video || video.width !== 1080 || video.height !== 1920) invalid();
  return { width: video.width, height: video.height, durationSeconds, hasAudio: Boolean(audio),
    audioMode: audio ? "original" : "muted" };
}

function inspectReadyVideo(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > MAX_VIDEO_BYTES) invalid();
  const fd = fs.openSync(file, "r");
  try {
    const top = [];
    for (let cursor = 0; cursor < stat.size;) {
      if (top.length >= 256) invalid();
      const header = Buffer.alloc(16);
      if (fs.readSync(fd, header, 0, 8, cursor) !== 8) invalid();
      let size = header.readUInt32BE(0), headerSize = 8;
      const type = header.toString("ascii", 4, 8);
      if (size === 1) {
        if (fs.readSync(fd, header, 8, 8, cursor + 8) !== 8) invalid();
        const wide = header.readBigUInt64BE(8);
        if (wide > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
        size = Number(wide); headerSize = 16;
      } else if (size === 0) size = stat.size - cursor;
      if (size < headerSize || cursor + size > stat.size || !/^[a-zA-Z0-9 ]{4}$/.test(type)) invalid();
      top.push({ type, start: cursor, end: cursor + size, headerSize });
      cursor += size;
    }
    const ftyp = top.filter(item => item.type === "ftyp");
    const moov = top.filter(item => item.type === "moov");
    const mdat = top.filter(item => item.type === "mdat");
    if (top[0] !== ftyp[0] || ftyp.length !== 1 || moov.length !== 1 || mdat.length !== 1 ||
        moov[0].end > MAX_HEADER_BYTES || moov[0].end > mdat[0].start ||
        mdat[0].end - mdat[0].start - mdat[0].headerSize < 16) invalid();
    const head = Buffer.alloc(moov[0].end);
    let offset = 0;
    while (offset < head.length) {
      const read = fs.readSync(fd, head, offset, head.length - offset, offset);
      if (!read) invalid();
      offset += read;
    }
    // A ready MP4 must put moov before mdat, so metadata is bounded and the
    // provider can retrieve it without waiting for the complete large file.
    const metadata = videoMetadata(head);
    const after = fs.fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs ||
        after.ino !== stat.ino || after.dev !== stat.dev) invalid();
    return metadata;
  } finally { fs.closeSync(fd); }
}

module.exports = { inspectReadyVideo, MAX_VIDEO_BYTES };
