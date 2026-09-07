# Editing the campus map

modSUTD's room map is drawn from OpenStreetMap. The 2026-08-22 walk was
surveyed, uploaded, and is now public map data - so **OSM is the source of
truth, and the `.osm` files on a maintainer's desktop are not**. They were the
upload payload. They stopped being true the moment anybody edited the map.

Everything below is about editing OSM itself, and confirming it took.

---

## Which tool for which job

| Job                                           | Tool                              |
| --------------------------------------------- | --------------------------------- |
| Change a tag on something that already exists | **The web editor.** Nothing else. |
| Draw a new floor, or many new rooms at once   | **JOSM**, downloading first       |
| Look at what the indoor data renders like     | **OpenLevelUp**                   |
| Confirm an edit actually landed               | **Overpass**                      |

---

## Change one tag: the web editor

This is the whole procedure, and it takes under a minute.

1. Open the object by id: `https://www.openstreetmap.org/edit`
2. Click **Edit**
3. Change the tag in the panel on the left
4. **Save**, with a short comment like `fix room plate 5.107-08 -> 5.101-08`

You need the object's id. Overpass gives you one - see _Confirming_ below - or
click the feature on openstreetmap.org and read it out of the address bar.

Do not use JOSM for this. It is the tool that causes the next problem.

---

## Do NOT re-upload the survey files

The `.osm` files the survey was uploaded from carry **negative placeholder
ids** (`-4802801`), which
is what "this object does not exist on the map yet" means in OSM's file format.
Uploading one of those files again asks the server to **create every object in
it a second time**, which is why an edit came back as a changeset touching
hundreds of nodes.

Editing the local file and re-uploading also does nothing to the map: the
objects already up there have real positive ids and never hear about it. This
has already happened once - the file said `5.101-08` while the map still said
`5.107-08`, and the site kept reporting the old value because the site reads the
map.

**If you want JOSM**, start from the map, never from the file:

1. Open JOSM with an empty layer
2. **File -> Download data** (Ctrl+Shift+D), draw a box over the area
3. Edit the objects that come back - they have real ids
4. **Upload**, and check the changeset says _modified_, not _created_

---

## Seeing the indoor data: OpenLevelUp

`https://openlevelup.net/?l=<osm level>#<zoom>/<lat>/<lon>`

For example, building 1 level 4 (which the door plates call Level 5):

    https://openlevelup.net/?l=3#21/1.340331/103.962382

What it gives you: every indoor shape on that floor, drawn, with a level
selector. It is the fastest way to see whether a room you added has geometry in
the right place.

What it does **not** give you: tags. It shows names, not `ref`s, so it cannot
tell you whether a door plate is right. And it queries Overpass live on every
load, so a blank map there means the query failed, not that your data is
missing.

That combination is exactly why the site draws the plan from a committed file
instead of embedding OpenLevelUp.

---

## Confirming an edit landed: Overpass

Overpass reads live OSM and shows you raw tags, which is the only way to check
a `ref`. Neither renderer will tell you.

One object, by id:

```bash
curl -s https://overpass-api.de/api/interpreter --data-urlencode \
  'data=[out:json];way(1554677285);out tags;'
```

Everything matching a plate pattern on campus:

```bash
curl -s https://overpass-api.de/api/interpreter --data-urlencode \
  'data=[out:json];way["ref"~"^5\.10"](1.3405,103.9605,1.3430,103.9640);out tags;'
```

Expect `"ref": "5.101-08"` in the answer. If you still see the old value, the
edit did not save.

Overpass 504s regularly. A 504 is not an answer - retry, or try
`https://overpass.kumi.systems/api/interpreter`.

---

## Getting an edit into the site

The site reads a committed snapshot, not OSM directly, because a page that
queries Overpass is blank whenever Overpass is unavailable. Refreshing that snapshot is one
command per file:

```bash
python tools/osm/extract_room_coords.py      # -> data/_meta/room-coords.json
python tools/osm/extract_indoor_geojson.py   # -> data/indoor.geojson
```

Both refuse to write a thin answer, so a bad Overpass day leaves the good file
alone rather than emptying it. Retry until one writes.

**Nobody has to remember this.** `.github/workflows/osm-refresh.yml` runs both
every Monday, and opens a pull request when the map has changed. Editing OSM is
the only step that needs a person.

---

## Things the data expects

- **Room plates go in `ref`**, the human name in `name`. The site matches a
  venue to a shape by `ref` first, then by `ref` with a trailing letter dropped
  (`1.404B` matches venue 1.404), then by exact `name`.
- **`level` is OSM's numbering, where the ground floor is 0.** The door plates
  count from 1, so plate "Level 3" is `level=2`. Put the plate's own wording in
  `level:ref` if you like; the site derives the display label itself.
- **Lifts are nodes**, `highway=elevator`, named `Lift Lobby A` and so on. Every
  set of directions the site gives ends in a lobby letter, so a floor with no
  lift node cannot be routed to.
- A shape with **neither `ref` nor `name`** is invisible to the site. Both
  hostel lobbies and Campus Centre are name-only, which is fine.
