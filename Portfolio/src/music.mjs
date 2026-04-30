import { writeFile } from "node:fs";

const REFRESH_TOKEN = process.env.SPOTIFY_REFRESH_TOKEN;
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

let TOKEN = null;

async function getAccessToken() {
  if (TOKEN) return TOKEN;
  
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: REFRESH_TOKEN,
    }),
  });
  
  const data = await res.json();
  if (!res.ok) {
    console.error('Failed to get access token:', data);
    process.exit(1);
  }
  
  TOKEN = data.access_token;
  return TOKEN;
}

async function fetchWebApi(endpoint, method, body) {
  const accessToken = await getAccessToken();
  const res = await fetch(`https://api.spotify.com/${endpoint}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    method,
    body:JSON.stringify(body)
  });
  return await res.json();
}

async function getTopTracks(){
  // Endpoint reference : https://developer.spotify.com/documentation/web-api/reference/get-users-top-artists-and-tracks
  return (await fetchWebApi(
    'v1/me/top/tracks?time_range=long_term&limit=20', 'GET'
  )).items;
}

const topTracks = await getTopTracks();
console.log(
  topTracks?.map(
    ({name, artists}) =>
      `${name} by ${artists.map(artist => artist.name).join(', ')}`
  )
);

const jsonString = JSON.stringify(topTracks, null, 2);

await writeFile('./src/topTracks.json', jsonString, 'utf-8', (err) => {
  if (err) {
    console.error('Error writing file:', err);
  } else {
    console.log('Top tracks saved to topTracks.json');
  }
});