/// Bounded circular PCM16 buffer retaining up to `max_seconds` of mono audio
/// (30s pre-connect capacity + 400ms VAD pre-roll extraction without allocations).
#[derive(Debug)]
pub struct Pcm16RingBuffer {
    buf: Vec<i16>,
    capacity: usize,
    write_pos: usize,
    len: usize,
    sample_rate: u32,
}

impl Pcm16RingBuffer {
    pub fn new(sample_rate: u32, max_seconds: usize) -> Self {
        let safe_rate = sample_rate.max(8000);
        let capacity = (safe_rate as usize) * max_seconds.max(1);
        Self {
            buf: vec![0; capacity],
            capacity,
            write_pos: 0,
            len: 0,
            sample_rate: safe_rate,
        }
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn clear(&mut self) {
        self.write_pos = 0;
        self.len = 0;
    }

    pub fn push_slice(&mut self, samples: &[i16]) {
        if samples.is_empty() || self.capacity == 0 {
            return;
        }
        if samples.len() >= self.capacity {
            let tail = &samples[samples.len() - self.capacity..];
            self.buf.copy_from_slice(tail);
            self.write_pos = 0;
            self.len = self.capacity;
            return;
        }
        for &s in samples {
            self.buf[self.write_pos] = s;
            self.write_pos = (self.write_pos + 1) % self.capacity;
        }
        self.len = (self.len + samples.len()).min(self.capacity);
    }

    pub fn peek_last_samples(&self, count: usize) -> Vec<i16> {
        let take = count.min(self.len);
        if take == 0 {
            return Vec::new();
        }
        let mut out = Vec::with_capacity(take);
        let start = (self.write_pos + self.capacity - take) % self.capacity;
        if start + take <= self.capacity {
            out.extend_from_slice(&self.buf[start..start + take]);
        } else {
            let first = self.capacity - start;
            out.extend_from_slice(&self.buf[start..]);
            out.extend_from_slice(&self.buf[..take - first]);
        }
        out
    }

    pub fn peek_last_ms(&self, ms: u32) -> Vec<i16> {
        let samples = ((self.sample_rate as u64 * ms as u64) / 1000) as usize;
        self.peek_last_samples(samples)
    }

    pub fn drain_all(&mut self) -> Vec<i16> {
        let out = self.peek_last_samples(self.len);
        self.clear();
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_buffer_wraps_oldest_and_drains_chronologically() {
        let mut rb = Pcm16RingBuffer::new(8000, 1); // capacity 8000
        let first: Vec<i16> = (1..=6000).map(|v| v as i16).collect();
        let second: Vec<i16> = (6001..=10000).map(|v| v as i16).collect();
        rb.push_slice(&first);
        rb.push_slice(&second);

        assert_eq!(rb.len(), 8000);
        let pre_roll = rb.peek_last_ms(100); // 800 samples at 8kHz
        assert_eq!(pre_roll.len(), 800);
        assert_eq!(pre_roll[0], 9201);
        assert_eq!(pre_roll[799], 10000);

        let drained = rb.drain_all();
        assert_eq!(drained.len(), 8000);
        assert_eq!(drained[0], 2001);
        assert_eq!(drained[7999], 10000);
        assert!(rb.is_empty());
    }
}
