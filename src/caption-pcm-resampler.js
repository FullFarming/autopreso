const INPUT_SAMPLE_RATE = 24_000;
const OUTPUT_SAMPLE_RATE = 16_000;
const FILTER_TAPS = 129;
const FILTER_HALF_LENGTH = (FILTER_TAPS - 1) / 2;
const FILTER_CUTOFF_HZ = 7_200;

function sinc(value) {
  if (Math.abs(value) < Number.EPSILON) return 1;
  const angle = Math.PI * value;
  return Math.sin(angle) / angle;
}

function createKernel(fraction) {
  const cutoff = FILTER_CUTOFF_HZ / INPUT_SAMPLE_RATE;
  const firstOffset = Math.ceil(fraction - FILTER_HALF_LENGTH);
  const lastOffset = Math.floor(fraction + FILTER_HALF_LENGTH);
  const weights = [];
  let weightSum = 0;
  for (let offset = firstOffset; offset <= lastOffset; offset += 1) {
    const distance = offset - fraction;
    const window = 0.42
      + 0.5 * Math.cos((Math.PI * distance) / FILTER_HALF_LENGTH)
      + 0.08 * Math.cos((2 * Math.PI * distance) / FILTER_HALF_LENGTH);
    const weight = 2 * cutoff * sinc(2 * cutoff * distance) * window;
    weights.push({ offset, weight });
    weightSum += weight;
  }
  return weights.map(({ offset, weight }) => ({ offset, weight: weight / weightSum }));
}

export function createCaptionPcmResampler() {
  const kernels = [createKernel(0), createKernel(0.5)];
  let history = new Int16Array(0);
  let inputSampleOffset = 0;
  let nextOutputPosition = 0;

  return function downsample(pcm24k) {
    const inputBuffer = Buffer.from(pcm24k);
    const input = new Int16Array(Math.floor(inputBuffer.length / 2));
    for (let index = 0; index < input.length; index += 1) input[index] = inputBuffer.readInt16LE(index * 2);
    if (input.length === 0) return Buffer.alloc(0);

    const combined = new Int16Array(history.length + input.length);
    combined.set(history);
    combined.set(input, history.length);
    const combinedOffset = inputSampleOffset - history.length;
    const inputEnd = inputSampleOffset + input.length;
    const output = [];

    while (Math.floor(nextOutputPosition) < inputEnd) {
      const delayedCenter = nextOutputPosition - FILTER_HALF_LENGTH;
      const centerIndex = Math.floor(delayedCenter);
      const fraction = delayedCenter - centerIndex;
      const kernel = fraction < 0.25 ? kernels[0] : kernels[1];
      let sample = 0;
      for (const { offset, weight } of kernel) {
        const combinedIndex = centerIndex + offset - combinedOffset;
        if (combinedIndex >= 0 && combinedIndex < combined.length) sample += combined[combinedIndex] * weight;
      }
      output.push(Math.max(-32_768, Math.min(32_767, Math.round(sample))));
      nextOutputPosition += INPUT_SAMPLE_RATE / OUTPUT_SAMPLE_RATE;
    }

    const historyLength = Math.min(FILTER_TAPS - 1, combined.length);
    history = combined.slice(combined.length - historyLength);
    inputSampleOffset = inputEnd;
    const outputBuffer = Buffer.alloc(output.length * 2);
    output.forEach((sample, index) => outputBuffer.writeInt16LE(sample, index * 2));
    return outputBuffer;
  };
}
