// Actions uses its conventional local engine; Jenkins explicitly selects its own rootless engine.
export function scannerDockerArguments(endpoint,uid){
 const socket=endpoint===undefined||endpoint===''?'/var/run/docker.sock':`/run/user/${uid}/docker.sock`;
 if(endpoint&&(!Number.isSafeInteger(uid)||uid<1000||endpoint!==`unix://${socket}`))throw new Error('Dedicated rootless scanner endpoint required');
 return ['run','--rm','-v',`${socket}:/run/gromesh/docker.sock:ro`,'-e','DOCKER_HOST=unix:///run/gromesh/docker.sock','-v','trivy-cache:/root/.cache/trivy'];
}
