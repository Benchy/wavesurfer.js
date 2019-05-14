import WaveSurfer from './wavesurfer';
import RegionPlugins from './plugin/regions';

export function createWavesurfer(param) {
    return new WaveSurfer(param);
}

export function createRegionsPlugin(param) {
    return RegionPlugins.create(param);
}
