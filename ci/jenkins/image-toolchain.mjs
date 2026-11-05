// Trivy0.69.3 is the immutable official release aligned with the upstream CI baseline.
// No latest/range/fallback: a host still needs its separately qualified native builder.
export function assertImageToolchain(v){
 if(!/Version:\s+1\.18\.1\b/.test(v?.syft??'')||!/Version:\s+0\.69\.3\b/.test(v?.trivy??'')||!/v0\.25\.0\b/.test(v?.buildx??''))throw Error('Pinned image toolchain required');
 return true;
}
