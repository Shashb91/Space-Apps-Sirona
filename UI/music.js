// The music button (bottom-left panel): music.mp3, next to index.html, loops in the background
// while it is on. Browsers only let a page start sound after a click, so it starts off.
// Each click switches it on or off, and its image follows (style.css):
//   off: textures/music_off.png (music_off_normal), mouse over: music_off_hover.png (music_off_mouse_over)
//   on:  textures/music_on.png (music_on_normal),   mouse over: music_on_hover.png (music_on_mouse_over)
const VOLUME = 0.5; // background music: half as loud as the file

export function setupMusic() {
  const button = document.getElementById("musicToggle");
  const audio = document.getElementById("music");
  audio.volume = VOLUME;
  let on = false;
  let problem = ""; // why the sound can't play (shown on the button), "" when it can

  const show = () => {
    button.setAttribute("aria-pressed", String(on));
    button.title = (on ? "Stop the music" : "Play the music") + (problem ? ` (${problem})` : "");
  };

  async function play() {
    try {
      await audio.play();
      problem = "";
    } catch (err) {
      if (err.name === "AbortError") return; // switched off again before it started: nothing wrong
      problem = err.name === "NotAllowedError" ? "the browser blocked the sound"
        : "music.mp3 could not be played: put it in the UI folder, next to index.html";
      console.warn(`Music: ${problem}`);
    }
    show();
  }

  button.addEventListener("click", () => {
    on = !on;
    show(); // the image changes at once, whether or not the sound can play
    if (on) play();
    else audio.pause();
  });

  // Its other images, so they show at once on hover and click
  for (const name of ["music_on", "music_on_hover", "music_off_hover"]) new Image().src = `textures/${name}.png`;
  show();
}
