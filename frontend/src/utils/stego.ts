const CANVAS_SIZE = 256;
const LENGTH_PREFIX_BITS = 32;

function numberToBits(value: number, length: number) {
  const bits = new Array<number>(length).fill(0);
  for (let i = 0; i < length; i += 1) {
    bits[length - 1 - i] = (value >> i) & 1;
  }
  return bits;
}

function bitsToNumber(bits: number[]) {
  let value = 0;
  for (let i = 0; i < bits.length; i += 1) {
    value = (value << 1) | (bits[i] & 1);
  }
  return value;
}

function textToBits(text: string) {
  const bytes = new TextEncoder().encode(text);
  const dataBits: number[] = [];
  bytes.forEach((byte) => {
    const chunk = numberToBits(byte, 8);
    dataBits.push(...chunk);
  });
  return [...numberToBits(bytes.length, LENGTH_PREFIX_BITS), ...dataBits];
}

export async function embedTextInImage(text: string) {
  const bits = textToBits(text);
  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_SIZE;
  canvas.height = CANVAS_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Canvas context unavailable');
  }
  ctx.fillStyle = '#0b1120';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const maxBits = canvas.width * canvas.height;
  if (bits.length > maxBits) {
    throw new Error('Message is too long for the cover image');
  }
  for (let i = 0; i < bits.length; i += 1) {
    const pixelOffset = i * 4 + 2; // set the blue channel LSB
    imageData.data[pixelOffset] = (imageData.data[pixelOffset] & 0xfe) | bits[i];
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL('image/png');
}

export async function extractTextFromImage(imageDataUrl: string) {
  const image = new Image();
  image.src = imageDataUrl;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Canvas context unavailable');
  }
  ctx.drawImage(image, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const bits: number[] = [];
  const totalPixels = canvas.width * canvas.height;
  for (let i = 0; i < totalPixels; i += 1) {
    bits.push(data[i * 4 + 2] & 1);
  }
  const lengthBits = bits.slice(0, LENGTH_PREFIX_BITS);
  const payloadLength = bitsToNumber(lengthBits);
  const payloadBits = bits.slice(LENGTH_PREFIX_BITS, LENGTH_PREFIX_BITS + payloadLength * 8);
  const bytes = new Uint8Array(payloadLength);
  for (let i = 0; i < payloadLength; i += 1) {
    const chunk = payloadBits.slice(i * 8, i * 8 + 8);
    bytes[i] = bitsToNumber(chunk);
  }
  return new TextDecoder().decode(bytes);
}
