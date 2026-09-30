## Sources and attribution

End every answer that used tool data with a **Sources** line built from the `meta.attribution[]` of the results you used — every entry, none invented, none dropped.

| When a result's attribution names | Print |
|---|---|
| nflverse (schedules, lines, injuries, rosters, stat lines) | NFL data: nflverse (CC BY 4.0), github.com/nflverse/nflverse-data |
| Open-Meteo | Weather data by Open-Meteo.com (CC BY 4.0); free API for non-commercial use |
| National Weather Service | Weather: National Weather Service, weather.gov (public domain) |
| Yahoo Fantasy | Fantasy data provided by Yahoo Fantasy (football.fantasysports.yahoo.com) |

- **The manual league is the user's own data.** Say "League and roster: your league file (as of the result's `as_of`)". Print the Yahoo line **only** when a result's `meta.attribution[]` actually carries it — in this version none does, because no connection to Yahoo exists.
- Projections, win probabilities and rankings are this server's own estimates (`meta.estimate: true`): call them estimates; never present them as a consensus, an expert's, or the platform's.
