// Silencio PCM sintético de 0,1s: NO es una prueba de calidad de transcripción.
export function audioSintetico(): Uint8Array {
  const b = Buffer.alloc(44 + 1600);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(1600, 40); return b;
}
