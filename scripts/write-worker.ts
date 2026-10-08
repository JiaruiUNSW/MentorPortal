import { getStandaloneBindings } from '../lib/standalone';
import { setBindingsProvider } from '../lib/runtime';
import { runAsyncJobs } from '../lib/mentor-data/async-worker';

const once=process.argv.includes('--once');
const bindings=getStandaloneBindings();setBindingsProvider(()=>bindings);
let stopping=false,timer:ReturnType<typeof setTimeout>|undefined,wake:(()=>void)|undefined;
const stop=()=>{stopping=true;if(timer)clearTimeout(timer);wake?.();};
process.on('SIGTERM',stop);process.on('SIGINT',stop);
try {
  do {
    try {await runAsyncJobs(bindings,{maxJobs:1});}
    catch {console.error(JSON.stringify({event:'mentor_writer_tick',outcome:'failed'}));if(once)process.exitCode=1;}
    if(!once&&!stopping)await new Promise<void>(resolve=>{wake=resolve;timer=setTimeout(resolve,1000);});
  } while(!once&&!stopping);
} finally {bindings.close();}
