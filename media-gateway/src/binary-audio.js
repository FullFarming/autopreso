export function encodeAudioFrame(header, pcm) {
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(headerBytes.byteLength);
  return Buffer.concat([length, headerBytes, Buffer.from(pcm)]);
}
