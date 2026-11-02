// Packs PNG images into a Windows .ico: a header, one directory entry per
// image, then the images. Hand-rolled rather
// than pulled from a package.
export function encodeIco(pngs: readonly Uint8Array[], sizes: readonly number[]): Buffer {
  if (pngs.length === 0 || pngs.length !== sizes.length) throw new Error("encodeIco: one size per image, and at least one image");

  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);

  const dir = Buffer.alloc(16 * pngs.length);
  let offset = header.length + dir.length;
  pngs.forEach((png, i) => {
    const entry = dir.subarray(i * 16, i * 16 + 16);
    const dim = sizes[i] >= 256 ? 0 : sizes[i]; // 0 means 256
    entry.writeUInt8(dim, 0);
    entry.writeUInt8(dim, 1);
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
  });

  return Buffer.concat([header, dir, ...pngs]);
}
