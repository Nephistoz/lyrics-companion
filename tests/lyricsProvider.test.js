// Offline checks for the title/artist matching in extension/lyricsProvider.js.
// No dependencies: run with `node tests/lyricsProvider.test.js`.
const assert = require("node:assert/strict");
const P = require("../extension/lyricsProvider.js");

// Version tags are stripped; useful words are kept.
const strip = {
  "Hotel California (2013 Remaster)": "Hotel California",
  "Bohemian Rhapsody - Remastered 2011": "Bohemian Rhapsody",
  "Mr. Brightside - Radio Edit": "Mr. Brightside",
  'Let It Go (From "Frozen")': "Let It Go",
  "TQG (feat. Nicki Minaj)": "TQG",
  "Despacito ft. Daddy Yankee": "Despacito",
  "Thunderstruck (Live at Donington)": "Thunderstruck",
  "Fallin' (Stay with Me)": "Fallin' (Stay with Me)", // "with" mid-bracket stays
  "Titanium (GRiZ Remix)": "Titanium (GRiZ Remix)", // remixes stay
};
for (const [input, want] of Object.entries(strip)) assert.equal(P.stripVersion(input), want, input);

// Channel names → real artist names.
assert.equal(P.cleanArtist("Adele - Topic"), "Adele");
assert.equal(P.cleanArtist("LuisFonsiVEVO"), "Luis Fonsi");
assert.equal(P.mainArtist("KAROL G & Nicki Minaj"), "KAROL G");
assert.equal(P.mainArtist("HUNTR/X, EJAE, AUDREY NUNA"), "HUNTR/X");
assert.equal(P.mainArtist("AC/DC"), "AC/DC");

// Video re-upload: "Queen - Song" by a random channel also tries Queen.
const v = P.buildVariants("Queen - Don't Stop Me Now (Official Video)", "Some Uploader");
assert.ok(v.titles.includes("Don't Stop Me Now"));
assert.ok(v.artists.includes("Queen"));
// ...but "Song - Radio Edit" is not split into artist/title.
assert.deepEqual(P.buildVariants("Mr. Brightside - Radio Edit", "The Killers").artists, ["The Killers"]);

// Similarity checks used to reject wrong search results.
assert.ok(P.titleMatches("Hotel California (2013 Remaster)", "Hotel California"));
assert.ok(P.titleMatches("Canción", "Cancion"));
assert.ok(!P.titleMatches("Hello", "Hello Goodbye"));
assert.ok(!P.titleMatches("Love", "Love Story"));
assert.ok(P.artistMatches(["LuisFonsi"], "Luis Fonsi, Daddy Yankee"));
assert.ok(!P.artistMatches(["Eagles"], "Adele"));
assert.ok(P.artistMatches([], "Anyone")); // manual search without an artist

console.log("lyricsProvider matching: all checks passed");
