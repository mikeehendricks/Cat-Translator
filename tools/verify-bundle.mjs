/* Acceptance test against the SHIPPED file: cat-translator.html as a user loads it.
   For every preset phrase: encode -> synthesise through the app's own voice -> run
   the app's own recogniser -> compare the text it hands back. */
import fs from 'node:fs'; import { JSDOM } from 'jsdom';
const html = fs.readFileSync('cat-translator.html', 'utf8');
const dom = new JSDOM(html, { runScripts: 'dangerously',
  beforeParse(win) {
    win.AudioContext = class { constructor(){ this.sampleRate=48000; this.state='running'; this.destination={}; }
      createGain(){ return { gain:{value:1,setValueAtTime(){},linearRampToValueAtTime(){}}, connect(){}, disconnect(){} }; }
      createBufferSource(){ return { buffer:null, connect(){}, start(){ setTimeout(()=>this.onended&&this.onended(),1); }, stop(){}, onended:null }; }
      createBiquadFilter(){ return { type:'',frequency:{value:0},Q:{value:0},gain:{value:0},connect(){} }; }
      createAnalyser(){ return { fftSize:2048, getByteTimeDomainData(a){ a.fill(128); }, connect(){} }; }
      createMediaStreamSource(){ return { connect(){} }; }
      createBuffer(ch,len,sr){
        const data = []; for (let i=0;i<ch;i++) data.push(new Float32Array(len||1));
        return { sampleRate:sr||this.sampleRate, length:len, duration:(len||1)/(sr||48000), numberOfChannels:ch,
          getChannelData:(i)=>data[i||0], copyToChannel:(a,i)=>{ data[i||0].set(a.subarray(0, data[i||0].length)); },
          copyFromChannel:(a,i)=>{ a.set(data[i||0].subarray(0, a.length)); } };
      }
      decodeAudioData(b,cb){ cb({ sampleRate:48000, getChannelData:()=>new Float32Array(48000), length:48000, duration:1 }); }
      resume(){} close(){} };
    win.navigator.mediaDevices = { getUserMedia: () => Promise.reject(new Error('denied')) };
  }});
const win = dom.window;
win.addEventListener('error', e => console.log('WINDOW ERROR:', e.error && e.error.stack));
await new Promise(r => setTimeout(r, 400));
const { MEOW_APP: A, MEOW_ENGINE: E } = win;

let ok = 0, total = 0;
/* the presets come from the shipped page itself, not from a list kept here */
const presets = [...win.document.querySelectorAll('#presets .preset b')].map(b => b.textContent.trim());
console.log(`presets found in the shipped page: ${presets.length}`);
for (const phrase of presets) {
  const enc = E.encode(phrase);
  const buf = A.bufferForTokens(enc.tokens, A.state.voice);
  A.recognise(buf.getChannelData(0), buf.sampleRate, 'check');
  const heard = win.document.querySelector('#listenResult .heard-head .big').textContent.trim();
  const want = E.decode(enc.tokens).text;
  const correct = heard === want;
  total++; ok += correct ? 1 : 0;
  console.log(`  ${phrase.padEnd(16)} -> "${heard}"   ${correct ? '✓' : '✗'}`);
}
/* and a couple of sentences the app has never synthesised before */
for (const sentence of ['hello cat come here','i am tired and hungry','no no no','where is my food']) {
  const enc = E.encode(sentence);
  const buf = A.bufferForTokens(enc.tokens, A.state.voice);
  A.recognise(buf.getChannelData(0), buf.sampleRate, 'check');
  const heard = win.document.querySelector('#listenResult .heard-head .big').textContent.trim();
  const want = E.decode(enc.tokens).text;
  total++; ok += heard === want ? 1 : 0;
  console.log(`  ${sentence.padEnd(26)} -> "${heard}"  (wanted "${want}")  ${heard === want ? '✓' : '✗'}`);
}
console.log(`\n  ${ok}/${total} read back exactly, through the shipped bundle`);
