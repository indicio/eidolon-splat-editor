export const fmtCount = (n: number) => n.toLocaleString('en-US');

export const fmtBytes = (n: number) => {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

export const fmtDist = (n: number) => (Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(2));
