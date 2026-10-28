# Bionic Beef Robotics, FRC Team 97

Website for the FIRST Robotics Competition team at Cambridge Rindge and Latin School.
Plain HTML + CSS + one small script. No build step, no dependencies.

## Pages

- `index.html`: home (hero, stats, latest news, subteams, gallery, sponsors, call to action)
- `about.html`: who we are, history timeline, 2026–27 student leadership, trophy case
- `robots.html`: 2026 robot, 2025 "Patrick Ewing", event results, season archive
- `sponsors.html`: sponsor logos and the pitch for new sponsors
- `join.html`: subteams, season calendar, how to join, FAQ, mentors and families

`css/style.css` is the whole design system. `js/site.js` runs the mobile menu, the smooth
scrolling (Lenis, loaded from jsDelivr, tuned to match us.nothing.tech: 1.1s, expo ease-out,
native scrolling on touch) and the home page animations. Add `data-reveal` (fade up) or
`data-wipe` (image wipes open) to any element to animate it in on scroll, with an optional
`style="--d:.2s"` delay. Visitors with reduced motion turned on get no animation.
Photos are in `assets/photos/` (resized to 1600px), and sponsor logos are in `assets/logos/`.

## Preview

```sh
python3 -m http.server 8097
# open http://localhost:8097
```

## Deploy

Upload the folder to any static host (GitHub Pages, Netlify, Cloudflare Pages).
Once you have a domain, change the `og:image` meta tag in every page to an absolute URL
so link previews show the photo.

## Updating each season

- The header and footer are copied into every page. If you change one, change all five.
- New season: add a section at the top of `robots.html`, a row at the top of its season
  archive, and a row in the `about.html` timeline if the team won an award.
- Leadership: edit the `.people` cards in `about.html`.
- Award count on the home page stats bar: update it when the team wins something.
- Results come from https://frc-events.firstinspires.org/team/97

## The robot build animation (home page)

`js/assembly.js` loads `assets/cad/robot.glb` with Three.js (from jsDelivr) and adds one
build step per scroll. The step text is the `<ol class="assembly-steps">` list in `index.html`.

`robot.glb` comes from the team's Onshape export (`Full Robot.3mf`, 32M triangles). It was
cut down to about 290k triangles and 430 KB so it runs on phones. Screws, nuts and
washers are left out.

The build steps come from the CAD's own sub-assemblies:

| Step | From the CAD |
|---|---|
| Frame | Chassis and Drivetrain, minus the swerve modules |
| Swerve modules | SDS MK4i ×4 and Swerve Covers |
| Electronics | electronics panel, Robot Battery |
| Hopper | Hopper, minus the indexer |
| Indexer | Bottom Indexer, Compliant Star Churros |
| Intake | Intake on polycarb |
| Shooter | Single Hood Assembly, gearboxes, Arducam mount, loose drive parts |
| Bumpers | Bumpers |

### Updating the model when the CAD changes

1. In Onshape, export the full robot assembly as **3MF**.
2. Run `sh tools/cad/build.sh "path/to/Full Robot.3mf"` (needs python3 and node).
3. If sub-assemblies were renamed or added, edit the grouping in `tools/cad/to_glb.py`
   (`STEPS`, `FROM`, and the name checks below them), and keep the list in `index.html`
   and the `/ 08` count and `--steps:8` on the section in sync.

`tools/` is only for building the model. Don't upload it with the site.
