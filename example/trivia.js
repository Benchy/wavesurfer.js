var wavesurfer = window.wavesurfer;
var currentSong = 1;
var GLOBAL_ACTIONS = {
    play: function() {
        wavesurfer.playPause();
        wavesurfer.setVolume(0.5);
    },

    back: function() {
        wavesurfer.skipBackward();
    },

    forth: function() {
        wavesurfer.skipForward();
    },

    crossfade: function() {
        if (currentSong == 1) {
            wavesurfer.crossfade('../media/song2.mp3', 1.5);
            currentSong = 2;
        } else {
            wavesurfer.crossfade('../media/song1.mp3', 1.5);
            currentSong = 1;
        }
    },

    'toggle-mute': function() {
        wavesurfer.toggleMute();
    }
};

// Bind actions to buttons and keypresses
document.addEventListener('DOMContentLoaded', function() {
    document.addEventListener('keydown', function(e) {
        var map = {
            32: 'play', // space
            37: 'back', // left
            39: 'forth' // right
        };
        var action = map[e.keyCode];
        if (action in GLOBAL_ACTIONS) {
            if (document == e.target || document.body == e.target) {
                e.preventDefault();
            }
            GLOBAL_ACTIONS[action](e);
        }
    });

    [].forEach.call(document.querySelectorAll('[data-action]'), function(el) {
        el.addEventListener('click', function(e) {
            var action = e.currentTarget.dataset.action;
            if (action in GLOBAL_ACTIONS) {
                e.preventDefault();
                GLOBAL_ACTIONS[action](e);
            }
        });
    });
});

// Misc
document.addEventListener('DOMContentLoaded', function() {
    // Web Audio not supported
    if (!window.AudioContext && !window.webkitAudioContext) {
        var demo = document.querySelector('#demo');
        if (demo) {
            demo.innerHTML = '<img src="/example/screenshot.png" />';
        }
    }

    // Navbar links
    var ul = document.querySelector('.nav-pills');
    var pills = ul.querySelectorAll('li');
    var active = pills[0];
    if (location.search) {
        var first = location.search.split('&')[0];
        var link = ul.querySelector('a[href="' + first + '"]');
        if (link) {
            active = link.parentNode;
        }
    }
    active && active.classList.add('active');
});
