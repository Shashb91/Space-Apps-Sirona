"""
temperature.py - surface temperature of the Moon from a 1-D thermal model of the regolith.

Model: Hayne et al. (2017), "Global regolith thermophysical properties of the Moon from the
Diviner Lunar Radiometer Experiment", JGR Planets 122, 2371-2400 (the model fitted to Diviner's
temperatures, published as the open-source code "heat1d"). Each column of regolith is heated by
the Sun at the top, by the Moon's interior at the bottom, and cools by thermal radiation:

    surface   eps sigma T0^4 = (1 - A(i)) S cos(i) + k dT/dz          energy balance (no heat capacity)
    inside    rho c(T) dT/dt = d/dz ( k(z, T) dT/dz )                   heat conduction
    bottom    k dT/dz = Q                                               geothermal heat flow

    A(i)     = A0 + a (i / 45deg)^3 + b (i / 90deg)^8                   albedo, i = solar incidence angle
    rho(z)   = rho_d - (rho_d - rho_s) exp(-z / H)                      density
    k(z, T)  = kc(z) (1 + chi (T / 350 K)^3)                            contact + radiative conduction
    kc(z)    = k_d - (k_d - k_s) exp(-z / H)
    c(T)     = polynomial fitted to lunar samples (Hemingway 1981, Ledlow 1992)

S is the solar flux (1361 W/m2 at 1 AU, constants.S0) and cos(i) = sin(lat) sin(dec) + cos(lat)
cos(dec) cos(h) for a smooth Moon, h being the hour angle and dec the Sun's declination.

For every latitude (0 to 90 deg) and solar declination (-1.6 to +1.6 deg: the lunar equator is
tilted 1.54 deg from the ecliptic, so the Sun stays within that band and changes its declination
over a year, not a month), the column is run lunar day after lunar day until the daily cycle
repeats. The surface temperature over the last day is stored as a table T(|lat|, dec, hour angle),
built once (about a minute) and cached in temperature_table.npz.

At a given time the Sun's position from the SPICE ephemerides (MOON_ME frame, as everywhere else)
gives the sub-solar longitude (so each point's hour angle), the declination and the Sun's distance;
the table is interpolated, and scaled by (1 AU / d)^(1/2) for the Sun's distance.

Not modelled (smooth Moon): slopes and shadows cast by the relief, eclipses of the Sun by the Earth,
and permanently shadowed craters (their real temperature is far below this model's polar values).
"""
import os
import numpy as np
from constants import AU, S0

TABLE_FILE = os.path.join(os.path.dirname(__file__), "temperature_table.npz")

# ---------------------------------------------------------------- Hayne et al. (2017) parameters
SIGMA = 5.670374419e-8         # Stefan-Boltzmann constant [W m-2 K-4]
EMISSIVITY = 0.95
ALBEDO = (0.12, 0.06, 0.25)    # A0, a, b
RHO_S, RHO_D = 1100.0, 1800.0  # density at the surface and at depth [kg m-3]
K_S, K_D = 7.4e-4, 3.4e-3      # contact conductivity at the surface and at depth [W m-1 K-1]
H_SCALE = 0.07                 # e-folding depth of density and conductivity [m]
CHI = 2.7                      # radiative conductivity parameter (at 350 K)
Q_GEO = 0.018                  # geothermal heat flow [W m-2]
CP_COEFF = (8.9093e-9, -1.2340e-5, 2.3616e-3, 2.7431, -3.6125)   # c(T) [J kg-1 K-1], highest power first
CP0 = 600.0                    # heat capacity used for the skin depth [J kg-1 K-1]
SYNODIC_DAY = 29.530589 * 86400.0   # one lunar day (Sun back at the same hour angle) [s]

# Layers (as in heat1d): 10 per skin depth at the top, each 20 % thicker than the one above,
# down to 20 skin depths (about 0.6 m, below which the daily cycle is not felt)
LAYERS_PER_SKIN, GROWTH, SKIN_DEPTHS = 10, 0.2, 20

# Table axes
LATS = np.arange(0.0, 90.0 + 0.5, 1.0)          # |latitude| [deg]
DECS = np.linspace(-1.6, 1.6, 9)                 # Sun declination, same sign as the latitude [deg]
N_HOURS = 720                                    # hour angle samples: -180 deg (midnight) + 0.5 deg steps
MAX_DAYS, TOLERANCE = 60, 0.05                   # stop when no surface value changes by more [K]
SPIN_UP_DAYS = 4                                 # days ending with the deep-layer correction below
VERSION = 1                                      # bump to rebuild the cached table


def heat_capacity(T):
    return np.polyval(CP_COEFF, T)


def albedo(i):
    """Albedo for a solar incidence angle i [rad] (brighter at grazing incidence)."""
    a0, a, b = ALBEDO
    return a0 + a * (i / (np.pi / 4)) ** 3 + b * (i / (np.pi / 2)) ** 8


def _grid():
    """Node depths z [m] (z[0] = 0 is the surface)."""
    kappa = K_S / (RHO_S * CP0)
    skin = np.sqrt(kappa * SYNODIC_DAY / np.pi)          # diurnal skin depth, about 3 cm
    dz = [skin / LAYERS_PER_SKIN]
    z = [0.0]
    while z[-1] < SKIN_DEPTHS * skin:
        dz.append(dz[-1] * (1 + GROWTH))
        z.append(z[-1] + dz[-1])
    return np.array(z)


def _absorbed(lat, dec, h):
    """Absorbed solar flux at 1 AU [W m-2]; lat, dec: (C,) rad, h: (N,) rad -> (N, C)."""
    cos_i = (np.sin(lat) * np.sin(dec))[None, :] + \
        (np.cos(lat) * np.cos(dec))[None, :] * np.cos(h)[:, None]
    cos_i = np.clip(cos_i, 0.0, 1.0)
    return (1.0 - albedo(np.arccos(cos_i))) * S0 * cos_i


def build_table(verbose=True):
    """Run the model for every (|lat|, dec) column until the daily cycle repeats.
    Returns T (len(LATS), len(DECS), N_HOURS) surface temperatures [K] at hour angles
    -180 + 360 * j / N_HOURS deg."""
    lat_c, dec_c = np.meshgrid(np.radians(LATS), np.radians(DECS), indexing="ij")
    lat_c, dec_c = lat_c.ravel(), dec_c.ravel()          # (C,) columns
    C = lat_c.size

    z = _grid()
    hz = np.diff(z)                                      # spacing between nodes (L-1,)
    rho = (RHO_D - (RHO_D - RHO_S) * np.exp(-z / H_SCALE))[:, None]
    kc = (K_D - (K_D - K_S) * np.exp(-z / H_SCALE))[:, None]
    r350 = CHI / 350.0 ** 3
    lap = (2.0 / (hz[1:] + hz[:-1]))[:, None]            # 1 / control-volume width
    hzc = hz[:, None]
    # Surface gradient, second order on the uneven grid: dT/dz = g0 T0 + g1 T1 + g2 T2
    h1, h2 = hz[0], hz[1]
    g0, g1, g2 = -(2 * h1 + h2) / (h1 * (h1 + h2)), (h1 + h2) / (h1 * h2), -h1 / (h2 * (h1 + h2))

    # Time step: the explicit scheme is stable when dt < rho c / (sum of k / dz^2) everywhere;
    # the tightest case is the coldest regolith (small heat capacity), half of it is kept
    def dt_limit(T):
        k = kc * (1 + r350 * T ** 3)
        kf = 0.5 * (k[1:] + k[:-1])
        s = lap * (kf[1:] / hzc[1:] + kf[:-1] / hzc[:-1])
        return float(np.min(rho[1:-1] * heat_capacity(T[1:-1]) / s))
    dt_max = 0.5 * min(dt_limit(np.full((len(z), 1), T)) for T in (20.0, 40.0, 100.0, 250.0, 420.0))
    sub = int(np.ceil(SYNODIC_DAY / N_HOURS / dt_max))   # model steps per stored sample
    n_steps = N_HOURS * sub
    dt = SYNODIC_DAY / n_steps

    h = np.radians(-180.0 + 360.0 * np.arange(n_steps) / n_steps)
    q_abs = _absorbed(lat_c, dec_c, h)                   # (steps, C)

    # Start from the noon radiative equilibrium / sqrt(2), as heat1d does (colder floor at the pole)
    noon = _absorbed(lat_c, dec_c, np.zeros(1))[0]
    t0 = np.maximum((noon / (EMISSIVITY * SIGMA)) ** 0.25 / np.sqrt(2), 40.0)
    T = np.repeat(t0[None, :], len(z), axis=0)           # (L, C)
    es = EMISSIVITY * SIGMA

    # The deep layers take years to settle from a guess. In the repeating daily cycle the mean heat
    # flux is Q at every depth; with k = kc(z) du/dT, u(T) = T + chi T^4 / (4 350^3) (Kirchhoff),
    # the daily mean of u must grow from the surface's by the integral of Q / kc. Over a day the
    # surface must also radiate what it absorbs plus Q (it matters in the dark polar columns,
    # which cool very slowly). The first days end by shifting each layer's u to meet both, so the
    # following days only refine it.
    def u_of(T):
        return T + 0.25 * r350 * T ** 4

    def T_of(u, T):
        for _ in range(8):
            T = T - (u_of(T) - u) / (1 + r350 * T ** 3)
        return T
    u_rise = np.concatenate([[0.0], np.cumsum(Q_GEO * hz / (0.5 * (kc[1:, 0] + kc[:-1, 0])))])[:, None]

    table = np.empty((N_HOURS, C))
    prev = None
    for day in range(1, MAX_DAYS + 1):
        spin_up = day <= SPIN_UP_DAYS
        u_sum = np.zeros_like(T)
        emit_sum = np.zeros(C)
        slope_sum = np.zeros(C)
        for step in range(n_steps):
            if step % sub == 0:
                table[step // sub] = T[0]
            if spin_up:
                u_sum += u_of(T)
                t3 = T[0] ** 3
                emit_sum += es * t3 * T[0]
                slope_sum += 4 * es * t3 / (1 + r350 * t3)     # d(emission)/du at the surface
            k = kc * (1 + r350 * T * T * T)
            kf = 0.5 * (k[1:] + k[:-1])
            flux = kf * np.diff(T, axis=0) / hzc         # upward-positive conduction between nodes
            T[1:-1] += dt / (rho[1:-1] * heat_capacity(T[1:-1])) * lap * (flux[1:] - flux[:-1])
            T[-1] = T[-2] + Q_GEO * hz[-1] / k[-2]       # geothermal flux at the bottom
            # Surface energy balance, Newton's method from the previous surface temperature
            Ts, q = T[0], q_abs[step]
            rest = g1 * T[1] + g2 * T[2]
            for _ in range(3):
                ks = kc[0] * (1 + r350 * Ts * Ts * Ts)
                grad = g0 * Ts + rest
                f = es * Ts ** 4 - q - ks * grad
                fp = 4 * es * Ts ** 3 - ks * g0 - 3 * kc[0] * r350 * Ts ** 2 * grad
                Ts = Ts - f / fp
            T[0] = Ts
        if spin_up:
            u_mean = u_sum / n_steps
            # Raising u everywhere by du changes the emission by at most slope * du (less in the
            # day, when the Sun sets the surface temperature), so this step never overshoots
            du = (q_abs.mean(axis=0) + Q_GEO - emit_sum / n_steps) / (slope_sum / n_steps)
            T = T_of(u_of(T) + (u_mean[:1] + du + u_rise) - u_mean, T)
        change = np.inf if prev is None else float(np.max(np.abs(table - prev)))
        if verbose:
            worst = np.unravel_index(np.argmax(np.abs(table - prev)), table.shape)[1] if prev is not None else 0
            print(f"  lunar day {day}: max change {change:.3f} K at lat {np.degrees(lat_c[worst]):.0f} "
                  f"dec {np.degrees(dec_c[worst]):.1f} (equator: noon {table[N_HOURS // 2, 0]:.1f} K, "
                  f"before dawn {table[N_HOURS // 4 - 1, 0]:.1f} K)")
        if change < TOLERANCE and not spin_up:
            break
        prev = table.copy()

    out = table.T.reshape(len(LATS), len(DECS), N_HOURS)
    meta = dict(dt=dt, n_layers=len(z), depth=z[-1], days=day, change=change)
    return out, meta


_TABLE = None


def table():
    """The T(|lat|, dec, hour angle) table, built and cached on first use."""
    global _TABLE
    if _TABLE is None:
        if os.path.exists(TABLE_FILE):
            data = np.load(TABLE_FILE)
            if int(data["version"]) == VERSION:
                _TABLE = data["T"].astype(np.float32)
        if _TABLE is None:
            print("Building the temperature table (Hayne et al. 2017 model, about a minute)...")
            T, meta = build_table()
            np.savez_compressed(TABLE_FILE, T=T.astype(np.float32), version=VERSION,
                                lats=LATS, decs=DECS, n_hours=N_HOURS, **meta)
            _TABLE = T.astype(np.float32)
    return _TABLE


def sun_geometry(sun):
    """From the Sun's position (T, 3) in MOON_ME [km]: sub-solar longitude [deg], declination
    [deg] and distance [km], each of shape (T,)."""
    sun = np.atleast_2d(sun)
    d = np.linalg.norm(sun, axis=1)
    return (np.degrees(np.arctan2(sun[:, 1], sun[:, 0])),
            np.degrees(np.arcsin(sun[:, 2] / d)), d)


def surface_temperature(lat, lon, sun):
    """Surface temperature [K] at points (lat, lon in deg, shape (P,)) for Sun positions sun
    (T, 3) in MOON_ME [km]. Returns (P, T)."""
    tab = table()
    lat = np.asarray(lat, dtype=float)
    lon = np.asarray(lon, dtype=float)
    lon_ss, dec, dist = sun_geometry(sun)

    # Latitude index (|lat|; the southern hemisphere sees the declination with the opposite sign)
    fl = np.clip(np.abs(lat), LATS[0], LATS[-1]) / (LATS[1] - LATS[0])
    i0 = np.minimum(fl.astype(int), len(LATS) - 2)
    wl = (fl - i0)[:, None]
    south = lat < 0
    step_d = DECS[1] - DECS[0]

    out = np.empty((lat.size, len(dec)))
    for t in range(len(dec)):
        # The table for this declination (north) and its mirror (south), shape (2, lat, hour)
        both = []
        for d in (dec[t], -dec[t]):
            fd = np.clip((d - DECS[0]) / step_d, 0, len(DECS) - 1)
            j = min(int(fd), len(DECS) - 2)
            w = fd - j
            both.append((1 - w) * tab[:, j] + w * tab[:, j + 1])
        both = np.stack(both)
        # Hour angle -> table column (periodic)
        hour = (lon - lon_ss[t] + 180.0) % 360.0 * (N_HOURS / 360.0)
        h0 = hour.astype(int) % N_HOURS
        h1 = (h0 + 1) % N_HOURS
        wh = hour - np.floor(hour)
        s = south.astype(int)
        top = (1 - wh) * both[s, i0, h0] + wh * both[s, i0, h1]
        bot = (1 - wh) * both[s, i0 + 1, h0] + wh * both[s, i0 + 1, h1]
        out[:, t] = (1 - wl[:, 0]) * top + wl[:, 0] * bot
    # Radiative scaling for the Sun's distance (the table is computed at 1 AU)
    return out * np.sqrt(AU / dist)[None, :]


if __name__ == "__main__":
    import time
    t = time.time()
    T, meta = build_table()
    print(f"built in {time.time() - t:.0f} s: {meta}")
    np.savez_compressed(TABLE_FILE, T=T.astype(np.float32), version=VERSION,
                        lats=LATS, decs=DECS, n_hours=N_HOURS, **meta)
    mid = len(DECS) // 2
    for la in (0, 30, 45, 60, 75, 85, 89, 90):
        row = T[int(la), mid]
        print(f"lat {la:2d}: noon {row[N_HOURS // 2]:6.1f} K, midnight {row[0]:6.1f} K, "
              f"before dawn {row[N_HOURS // 4 - 1]:6.1f} K, mean {row.mean():6.1f} K")
