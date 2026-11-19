# app.py

import os
import sys
import json
import time
import threading
import sqlite3
import logging

from datetime import datetime, timedelta, timezone

from flask import (
    Flask,
    jsonify,
    request,
    render_template,
    session
)

from waitress import serve

import pyodbc

from dotenv import load_dotenv

from werkzeug.security import (
    check_password_hash,
    generate_password_hash
)

from logging.handlers import RotatingFileHandler


# ---------------------------------------------------------------------------
# 1. SETUP & CONFIGURATION
# ---------------------------------------------------------------------------

load_dotenv()


try:
    from zoneinfo import ZoneInfo

    IST = ZoneInfo("Asia/Kolkata")

except Exception:

    # Reliable fallback on Windows systems without tzdata installed
    IST = timezone(
        timedelta(
            hours=5,
            minutes=30
        ),
        name="IST"
    )


app = Flask(
    __name__,
    static_folder='static',
    template_folder='templates'
)


app.secret_key = os.getenv(
    'FLASK_SECRET_KEY',
    os.urandom(24)
)


app.config[
    'PERMANENT_SESSION_LIFETIME'
] = timedelta(minutes=15)


os.makedirs(
    'logs',
    exist_ok=True
)

os.makedirs(
    'data',
    exist_ok=True
)


logger = logging.getLogger(
    'PelletDashboard'
)

logger.setLevel(
    logging.INFO
)


handler = RotatingFileHandler(
    'logs/dashboard.log',
    maxBytes=5 * 1024 * 1024,
    backupCount=5
)


formatter = logging.Formatter(
    '%(asctime)s - %(levelname)s - %(message)s'
)


handler.setFormatter(
    formatter
)

logger.addHandler(
    handler
)


CACHE = {
    'tags': {},
    'status': 'STANDBY',
    'last_error': None,
    'last_success_utc': None,
    'cycle_ms': 0
}


CACHE_LOCK = threading.Lock()


with open(
    'tags.json',
    'r'
) as f:

    TAG_CONFIG = json.load(f)

    TAG_LIST = [
        t['historian_tag']
        for t in TAG_CONFIG
    ]


def load_thresholds():

    with open(
        'thresholds.json',
        'r'
    ) as f:

        return json.load(f)


# ---------------------------------------------------------------------------
# 2. LOCAL TREND DATABASE (SQLite)
# ---------------------------------------------------------------------------

def init_local_db():

    conn = sqlite3.connect(
        'data/history.db'
    )

    c = conn.cursor()


    c.execute(
        '''
        CREATE TABLE IF NOT EXISTS trend_data
        (
            ts_utc TEXT,
            tag_name TEXT,
            tag_value REAL
        )
        '''
    )


    c.execute(
        '''
        CREATE INDEX IF NOT EXISTS idx_trend
        ON trend_data(tag_name, ts_utc)
        '''
    )


    conn.commit()

    conn.close()


def save_trend_data(
    ts,
    data
):

    conn = sqlite3.connect(
        'data/history.db'
    )

    c = conn.cursor()


    for tag, val in data.items():

        if val is not None:

            c.execute(
                "INSERT INTO trend_data VALUES (?, ?, ?)",
                (
                    ts.isoformat(),
                    tag,
                    val
                )
            )


    # 90-day retention cleanup

    cutoff = (
        datetime.now(
            timezone.utc
        ) -
        timedelta(days=90)
    ).isoformat()


    c.execute(
        "DELETE FROM trend_data WHERE ts_utc < ?",
        (cutoff,)
    )


    conn.commit()

    conn.close()


init_local_db()


# ---------------------------------------------------------------------------
# 3. BACKGROUND POLLER THREAD
# ---------------------------------------------------------------------------

def get_db_connection():

    driver = (
        os.getenv(
            'PP_SQL_DRIVER',
            ''
        )
        .strip()
        .strip("'\"")
    )


    if not driver:

        drivers = pyodbc.drivers()


        if (
            'ODBC Driver 18 for SQL Server'
            in drivers
        ):

            driver = (
                'ODBC Driver 18 for SQL Server'
            )


        elif (
            'ODBC Driver 17 for SQL Server'
            in drivers
        ):

            driver = (
                'ODBC Driver 17 for SQL Server'
            )


        elif (
            'SQL Server'
            in drivers
        ):

            driver = 'SQL Server'


        else:

            driver = (
                drivers[0]
                if drivers
                else 'SQL Server'
            )


    pwd = os.getenv(
        'PP_SQL_PASSWORD',
        ''
    )


    if not pwd:

        return None


    conn_str = (

        f"DRIVER={{{driver}}};"

        f"SERVER="
        f"{os.getenv('PP_SQL_HOST')},"
        f"{os.getenv('PP_SQL_PORT')};"

        f"DATABASE="
        f"{os.getenv('PP_SQL_DATABASE')};"

        f"UID="
        f"{os.getenv('PP_SQL_USERNAME')};"

        f"PWD={pwd};"

        f"Encrypt="
        f"{os.getenv('PP_SQL_ENCRYPT', 'no')};"

        f"TrustServerCertificate="
        f"{os.getenv('PP_SQL_TRUST_CERT', 'yes')};"
    )


    return pyodbc.connect(
        conn_str,
        timeout=5
    )


def poller_loop():

    logger.info(
        "Poller thread started."
    )


    last_trend_save = time.time()

    retry_backoff = 3


    while True:

        cycle_start = time.time()


        try:

            conn = get_db_connection()


            if not conn:

                with CACHE_LOCK:

                    CACHE[
                        'status'
                    ] = 'STANDBY'


                time.sleep(3)

                continue


            placeholders = ','.join(
                ['?'] * len(TAG_LIST)
            )


            query = f"""
            SELECT
                tag_name,
                ts_utc,
                TRY_CONVERT(
                    float,
                    tag_value
                ) AS tag_value

            FROM
            (
                SELECT
                    tag_name,
                    ts_utc,
                    tag_value,

                    ROW_NUMBER()
                    OVER
                    (
                        PARTITION BY tag_name
                        ORDER BY ts_utc DESC
                    ) rn

                FROM dbo.L1_VW_PP_TagData

                WHERE
                    asset_path='pp'

                    AND tag_name
                    IN ({placeholders})

                    AND ts_utc >
                    DATEADD(
                        minute,
                        -10,
                        GETUTCDATE()
                    )

            ) t

            WHERE rn=1;
            """


            cursor = conn.cursor()

            cursor.execute(
                query,
                TAG_LIST
            )


            rows = cursor.fetchall()


            now_utc = datetime.now(
                timezone.utc
            )


            thresholds = load_thresholds()


            stale_limit = thresholds.get(
                'stale_after_seconds',
                60
            )


            trend_snapshot = {
                'DAY PRODUCTION': None,
                'MOISTURE ANAYZER MO2': None
            }


            with CACHE_LOCK:

                for row in rows:

                    tag = row[0]
                    ts = row[1]
                    val = row[2]


                    # Robust parsing for string or datetime objects

                    parsed_ts = None


                    if isinstance(
                        ts,
                        str
                    ):

                        clean_ts = (
                            ts
                            .rstrip('Z')
                            .replace(
                                ' ',
                                'T'
                            )
                        )


                        try:

                            parsed_ts = (
                                datetime.fromisoformat(
                                    clean_ts
                                )
                            )


                        except Exception:

                            try:

                                base_str = (
                                    ts
                                    .split('.')[0]
                                    .strip()
                                )


                                parsed_ts = (
                                    datetime.strptime(
                                        base_str,
                                        "%Y-%m-%d %H:%M:%S"
                                    )
                                )


                            except Exception:

                                parsed_ts = now_utc


                    elif isinstance(
                        ts,
                        datetime
                    ):

                        parsed_ts = ts


                    else:

                        parsed_ts = now_utc


                    # Ensure timezone awareness

                    if (
                        parsed_ts.tzinfo
                        is None
                    ):

                        parsed_ts = (
                            parsed_ts.replace(
                                tzinfo=timezone.utc
                            )
                        )


                    age = (
                        now_utc -
                        parsed_ts
                    ).total_seconds()


                    quality = (
                        'GOOD'
                        if age <= stale_limit
                        else 'STALE'
                    )


                    if val is None:

                        quality = 'BAD'


                    CACHE[
                        'tags'
                    ][tag] = {

                        'value': val,

                        'ts_utc':
                            parsed_ts.isoformat(),

                        'quality':
                            quality
                    }


                    if (
                        tag in trend_snapshot
                        and
                        quality == 'GOOD'
                    ):

                        trend_snapshot[
                            tag
                        ] = val


                CACHE[
                    'status'
                ] = 'LIVE'


                CACHE[
                    'last_error'
                ] = None


                CACHE[
                    'last_success_utc'
                ] = now_utc.isoformat()


            # Save trends every 30 seconds

            if (
                time.time() -
                last_trend_save
                >= 30
            ):

                save_trend_data(
                    now_utc,
                    trend_snapshot
                )


                last_trend_save = (
                    time.time()
                )


            conn.close()

            retry_backoff = 3


        except Exception as e:

            logger.error(
                f"Poller error: {str(e)}"
            )


            with CACHE_LOCK:

                CACHE[
                    'status'
                ] = 'DATA_UNAVAILABLE'

                CACHE[
                    'last_error'
                ] = str(e)


            time.sleep(
                retry_backoff
            )


            retry_backoff = min(
                15,
                retry_backoff + 3
            )


            continue


        finally:

            cycle_ms = int(
                (
                    time.time() -
                    cycle_start
                ) *
                1000
            )


            with CACHE_LOCK:

                CACHE[
                    'cycle_ms'
                ] = cycle_ms


        time.sleep(
            max(
                0.5,
                3.0 -
                (
                    time.time() -
                    cycle_start
                )
            )
        )


threading.Thread(
    target=poller_loop,
    daemon=True
).start()


# ---------------------------------------------------------------------------
# 4. BUSINESS LOGIC & API
# ---------------------------------------------------------------------------

def compute_dashboard_state():

    with CACHE_LOCK:

        raw_cache = dict(
            CACHE
        )


    t = load_thresholds()


    state = {

        'status':
            raw_cache['status'],

        'last_success_utc':
            raw_cache[
                'last_success_utc'
            ],

        'cycle_ms':
            raw_cache.get(
                'cycle_ms',
                0
            ),

        'server_time_ist':
            datetime.now(
                IST
            ).strftime(
                '%H:%M:%S IST'
            ),

        'thresholds': t,

        'kpis': {},

        'bins': {},

        'alarms': []
    }


    def get_val(
        tag_name
    ):

        data = (
            raw_cache[
                'tags'
            ].get(
                tag_name,
                {
                    'value': None,
                    'quality': 'BAD'
                }
            )
        )


        return (
            data['value'],
            data['quality']
        )


    # Day Production

    prod_val, prod_q = get_val(
        'DAY PRODUCTION'
    )


    prod_tgt = t.get(
        'day_production_target_mt',
        16000
    )


    prod_pct = (
        round(
            (
                prod_val /
                prod_tgt *
                100
            ),
            1
        )

        if (
            prod_val is not None
            and
            prod_tgt
        )

        else 0
    )


    prod_color = (

        'green'
        if prod_pct >= 100

        else (
            'blue'
            if prod_pct >= 50

            else 'amber'
        )
    )


    state[
        'kpis'
    ][
        'production'
    ] = {

        'value':
            prod_val,

        'target':
            prod_tgt,

        'pct':
            prod_pct,

        'color':
            prod_color,

        'quality':
            prod_q
    }


    # Moisture

    moist_val, moist_q = get_val(
        'MOISTURE ANAYZER MO2'
    )


    m_color = 'grey'


    if (
        moist_q == 'GOOD'
        and
        moist_val is not None
    ):

        if (
            moist_val <
            t.get(
                'moisture_green_max',
                10.0
            )
        ):

            m_color = 'green'


        elif (
            moist_val <=
            t.get(
                'moisture_yellow_max',
                11.5
            )
        ):

            m_color = 'yellow'


        else:

            m_color = 'red'


            state[
                'alarms'
            ].append(
                f"Moisture High: "
                f"{moist_val}%"
            )


    state[
        'kpis'
    ][
        'moisture'
    ] = {

        'value':
            moist_val,

        'color':
            m_color,

        'quality':
            moist_q
    }


    # Feeds & Variance

    gp3_val, gp3_q = get_val(
        'GP-3 FEED'
    )


    tg_val, tg_q = get_val(
        'TG ACTUAL FEED'
    )


    gp3_sp = t.get(
        'gp3_setpoint_tph',
        440
    )


    gp3_dev = (

        round(
            gp3_val -
            gp3_sp,
            1
        )

        if (
            gp3_q == 'GOOD'
            and
            gp3_val is not None
        )

        else None
    )


    state[
        'kpis'
    ][
        'gp3'
    ] = {

        'value':
            gp3_val,

        'setpoint':
            gp3_sp,

        'deviation':
            gp3_dev,

        'quality':
            gp3_q
    }


    state[
        'kpis'
    ][
        'tg'
    ] = {

        'value':
            tg_val,

        'quality':
            tg_q
    }


    if (
        gp3_q == 'GOOD'
        and
        tg_q == 'GOOD'
        and
        gp3_val is not None
        and
        tg_val is not None
    ):

        var_val = round(
            tg_val -
            gp3_val,
            1
        )


        abs_var = abs(
            var_val
        )


        v_color = (

            'green'

            if abs_var <=
            t.get(
                'variance_green_tph',
                5
            )

            else (

                'amber'

                if abs_var <=
                t.get(
                    'variance_amber_tph',
                    20
                )

                else 'red'
            )
        )


        state[
            'kpis'
        ][
            'variance'
        ] = {

            'value':
                var_val,

            'color':
                v_color,

            'quality':
                'GOOD'
        }


    else:

        state[
            'kpis'
        ][
            'variance'
        ] = {

            'value': None,

            'color': 'grey',

            'quality': 'BAD'
        }


    # Bins

    bin_letters = [
        'B',
        'C',
        'D',
        'E',
        'F',
        'G',
        'H',
        'I',
        'J',
        'K',
        'L'
    ]


    sum_bins = 0

    good_bins = 0

    starving_count = 0


    for b in bin_letters:

        b_val, b_q = get_val(
            f'{b} BALLING DISC BIN'
        )


        b_color = 'grey'

        b_state = 'STALE'


        if (
            b_q == 'GOOD'
            and
            b_val is not None
        ):

            sum_bins += b_val

            good_bins += 1


            if (
                b_val <
                t.get(
                    'bin_starvation_pct',
                    15
                )
            ):

                b_color = 'red'

                b_state = 'STARVING'

                starving_count += 1


                state[
                    'alarms'
                ].append(
                    f"Bin {b} "
                    f"{b_val}% STARVING"
                )


            elif (
                b_val <
                t.get(
                    'bin_low_pct',
                    25
                )
            ):

                b_color = 'yellow'

                b_state = 'LOW'


            elif (
                b_val <=
                t.get(
                    'bin_overfeed_pct',
                    80
                )
            ):

                b_color = 'blue'

                b_state = 'NORMAL'


            else:

                b_color = 'red'

                b_state = 'OVERFEED'


                state[
                    'alarms'
                ].append(
                    f"Bin {b} "
                    f"{b_val}% OVERFEED"
                )


        state[
            'bins'
        ][b] = {

            'value':
                b_val,

            'color':
                b_color,

            'state':
                b_state,

            'quality':
                b_q
        }


    state[
        'kpis'
    ][
        'avg_bin'
    ] = {

        'value':

            round(
                sum_bins /
                good_bins,
                1
            )

            if good_bins > 0

            else None,

        'good_count':
            good_bins
    }


    state[
        'kpis'
    ][
        'starvation_count'
    ] = starving_count


    return state


# ---------------------------------------------------------------------------
# MAIN PAGE
# ---------------------------------------------------------------------------

@app.route('/')
def index():

    return render_template(
        'index.html'
    )


# ---------------------------------------------------------------------------
# TAG API
# ---------------------------------------------------------------------------

@app.route('/api/tags')
def api_tags():

    return jsonify(
        compute_dashboard_state()
    )


# ---------------------------------------------------------------------------
# TREND HELPERS
# ---------------------------------------------------------------------------

def downsample_trend(
    result,
    max_points=600
):
    """
    Evenly downsample a chronological trend while preserving
    the first and last records.
    """

    if (
        not result
        or
        len(result) <= max_points
    ):

        return result


    step = (
        len(result) - 1
    ) / (
        max_points - 1
    )


    sampled = []


    for i in range(
        max_points
    ):

        index = round(
            i * step
        )


        index = min(
            index,
            len(result) - 1
        )


        sampled.append(
            result[index]
        )


    return sampled


def read_sqlite_trend(
    tag_name,
    utc_start=None,
    utc_end=None,
    live_limit=None
):
    """
    Read trend values from the existing local SQLite database.
    """

    conn = None


    try:

        conn = sqlite3.connect(
            'data/history.db'
        )


        c = conn.cursor()


        if live_limit:

            c.execute(
                """
                SELECT
                    ts_utc,
                    tag_value

                FROM trend_data

                WHERE tag_name = ?

                ORDER BY ts_utc DESC

                LIMIT ?
                """,
                (
                    tag_name,
                    live_limit
                )
            )


            rows = list(
                reversed(
                    c.fetchall()
                )
            )


        else:

            c.execute(
                """
                SELECT
                    ts_utc,
                    tag_value

                FROM trend_data

                WHERE
                    tag_name = ?

                    AND ts_utc >= ?

                    AND ts_utc <= ?

                ORDER BY ts_utc ASC
                """,
                (
                    tag_name,
                    utc_start.isoformat(),
                    utc_end.isoformat()
                )
            )


            rows = c.fetchall()


        result = []


        for row in rows:

            if (
                row[0] is None
                or
                row[1] is None
            ):

                continue


            try:

                numeric_value = float(
                    row[1]
                )

            except (
                ValueError,
                TypeError
            ):

                continue


            result.append({
                'ts': row[0],
                'value': numeric_value
            })


        return result


    finally:

        if conn:

            conn.close()


def read_historian_trend(
    tag_name,
    utc_start,
    utc_end
):
    """
    Read historical trend directly from SQL Server Historian.

    utc_start and utc_end must be timezone-aware UTC datetime
    objects.
    """

    conn = None


    try:

        conn = get_db_connection()


        if not conn:

            raise RuntimeError(
                'Historian database connection unavailable'
            )


        cursor = conn.cursor()


        # SQL Server/pyodbc works reliably with timezone-naive
        # datetime parameters.
        #
        # These datetime objects still REPRESENT UTC.

        sql_start = (
            utc_start
            .astimezone(
                timezone.utc
            )
            .replace(
                tzinfo=None
            )
        )


        sql_end = (
            utc_end
            .astimezone(
                timezone.utc
            )
            .replace(
                tzinfo=None
            )
        )


        query = """
        SELECT
            ts_utc,
            TRY_CONVERT(
                float,
                tag_value
            ) AS tag_value

        FROM dbo.L1_VW_PP_TagData

        WHERE
            asset_path = 'pp'

            AND tag_name = ?

            AND ts_utc >= ?

            AND ts_utc <= ?

            AND TRY_CONVERT(
                float,
                tag_value
            ) IS NOT NULL

        ORDER BY ts_utc ASC;
        """


        cursor.execute(
            query,
            (
                tag_name,
                sql_start,
                sql_end
            )
        )


        rows = cursor.fetchall()


        result = []


        for row in rows:

            ts = row[0]

            value = row[1]


            if (
                ts is None
                or
                value is None
            ):

                continue


            # Historian field is ts_utc.
            # pyodbc generally returns SQL datetime as naive.
            # Explicitly mark it as UTC before sending to browser.

            if isinstance(
                ts,
                datetime
            ):

                if ts.tzinfo is None:

                    ts = ts.replace(
                        tzinfo=timezone.utc
                    )


                else:

                    ts = ts.astimezone(
                        timezone.utc
                    )


                ts_value = (
                    ts.isoformat()
                )


            else:

                ts_value = str(
                    ts
                )


            try:

                numeric_value = float(
                    value
                )

            except (
                ValueError,
                TypeError
            ):

                continue


            result.append({
                'ts': ts_value,
                'value': numeric_value
            })


        return result


    finally:

        if conn:

            try:

                conn.close()

            except Exception:

                pass


# ---------------------------------------------------------------------------
# TREND API
# ---------------------------------------------------------------------------

@app.route('/api/trend')
def api_trend():

    metric = request.args.get(
        'metric',
        'moisture'
    )


    rng = request.args.get(
        'range',
        'live'
    )


    # Frontend metric -> Historian tag

    tag_name = (

        'DAY PRODUCTION'

        if metric == 'production'

        else 'MOISTURE ANAYZER MO2'
    )


    # =======================================================================
    # LIVE
    #
    # Keep the original implementation:
    # latest 40 locally-recorded values.
    # =======================================================================

    if rng == 'live':

        try:

            result = read_sqlite_trend(
                tag_name,
                live_limit=40
            )


            return jsonify(
                result
            )


        except Exception as e:

            logger.error(
                f"Live trend error: "
                f"{str(e)}"
            )


            return jsonify([])


    # =======================================================================
    # DAILY
    #
    # Complete operating day:
    #
    # 22:00 IST -> 22:00 IST
    # =======================================================================

    if rng == 'daily':

        now_ist = datetime.now(
            IST
        )


        if now_ist.hour >= 22:

            shift_start_ist = (
                now_ist.replace(
                    hour=22,
                    minute=0,
                    second=0,
                    microsecond=0
                )
            )


        else:

            yesterday_ist = (
                now_ist -
                timedelta(days=1)
            )


            shift_start_ist = (
                yesterday_ist.replace(
                    hour=22,
                    minute=0,
                    second=0,
                    microsecond=0
                )
            )


        shift_end_ist = (
            shift_start_ist +
            timedelta(hours=24)
        )


        utc_start = (
            shift_start_ist
            .astimezone(
                timezone.utc
            )
        )


        utc_end = (
            shift_end_ist
            .astimezone(
                timezone.utc
            )
        )


    # =======================================================================
    # CUSTOM
    # =======================================================================

    elif rng == 'custom':

        from_value = (
            request.args.get(
                'from',
                ''
            )
            .strip()
        )


        to_value = (
            request.args.get(
                'to',
                ''
            )
            .strip()
        )


        if (
            not from_value
            or
            not to_value
        ):

            return jsonify({
                'error':
                    'Both from and to are required'
            }), 400


        try:

            utc_start = (
                datetime.fromisoformat(
                    from_value.replace(
                        'Z',
                        '+00:00'
                    )
                )
            )


            utc_end = (
                datetime.fromisoformat(
                    to_value.replace(
                        'Z',
                        '+00:00'
                    )
                )
            )


            # Defensive handling if timezone was omitted

            if utc_start.tzinfo is None:

                utc_start = (
                    utc_start.replace(
                        tzinfo=timezone.utc
                    )
                )


            if utc_end.tzinfo is None:

                utc_end = (
                    utc_end.replace(
                        tzinfo=timezone.utc
                    )
                )


            utc_start = (
                utc_start.astimezone(
                    timezone.utc
                )
            )


            utc_end = (
                utc_end.astimezone(
                    timezone.utc
                )
            )


            if (
                utc_start >=
                utc_end
            ):

                return jsonify({
                    'error':
                        'From time must be before To time'
                }), 400


        except Exception as e:

            logger.warning(
                f"Invalid custom trend range: "
                f"{str(e)}"
            )


            return jsonify({
                'error':
                    'Invalid custom date/time range'
            }), 400


    else:

        return jsonify({
            'error':
                f'Unsupported trend range: {rng}'
        }), 400


    # =======================================================================
    # HISTORIAN
    # =======================================================================

    try:

        result = read_historian_trend(
            tag_name,
            utc_start,
            utc_end
        )


        logger.info(
            f"Historian trend: "
            f"metric={metric}, "
            f"range={rng}, "
            f"from={utc_start.isoformat()}, "
            f"to={utc_end.isoformat()}, "
            f"raw_points={len(result)}"
        )


        result = downsample_trend(
            result,
            600
        )


        logger.info(
            f"Historian trend response: "
            f"metric={metric}, "
            f"range={rng}, "
            f"points={len(result)}"
        )


        return jsonify(
            result
        )


    # =======================================================================
    # FALLBACK TO EXISTING SQLITE HISTORY
    # =======================================================================

    except Exception as e:

        logger.error(
            f"Historian trend failed: "
            f"{str(e)}"
        )


        try:

            result = read_sqlite_trend(
                tag_name,
                utc_start=utc_start,
                utc_end=utc_end
            )


            result = downsample_trend(
                result,
                600
            )


            logger.warning(
                f"Historian unavailable. "
                f"Using SQLite fallback: "
                f"{len(result)} points"
            )


            return jsonify(
                result
            )


        except Exception as fallback_error:

            logger.error(
                f"Trend SQLite fallback failed: "
                f"{str(fallback_error)}"
            )


            return jsonify([])


# ---------------------------------------------------------------------------
# HEALTH
# ---------------------------------------------------------------------------

@app.route('/healthz')
def healthz():

    with CACHE_LOCK:

        age = (

            (
                datetime.now(
                    timezone.utc
                ) -

                datetime.fromisoformat(
                    CACHE[
                        'last_success_utc'
                    ]
                )
            ).total_seconds()

            if CACHE[
                'last_success_utc'
            ]

            else -1
        )


        return jsonify({

            'status':
                CACHE['status'],

            'cache_age_seconds':
                age,

            'db_connected':
                CACHE[
                    'status'
                ] == 'LIVE',

            'version':
                '1.0.0'
        })


# ---------------------------------------------------------------------------
# 5. ADMIN ROUTES
# ---------------------------------------------------------------------------

@app.route(
    '/api/admin/login',
    methods=['POST']
)
def login():

    data = (
        request.json
        or {}
    )


    pwd = data.get(
        'password',
        ''
    )


    pwd_hash = os.getenv(
        'ADMIN_PASSWORD_HASH',
        ''
    )


    if not pwd_hash:

        return jsonify({
            "error":
                "Admin password not set on host"
        }), 500


    if check_password_hash(
        pwd_hash,
        pwd
    ):

        session[
            'admin'
        ] = True


        logger.info(
            f"Admin login success from "
            f"{request.remote_addr}"
        )


        return jsonify({
            "status":
                "ok"
        })


    logger.warning(
        f"Admin login failed from "
        f"{request.remote_addr}"
    )


    return jsonify({
        "error":
            "Unauthorized"
    }), 401


@app.route(
    '/api/admin/logout',
    methods=['POST']
)
def logout():

    session.pop(
        'admin',
        None
    )


    return jsonify({
        "status":
            "ok"
    })


@app.route(
    '/api/config',
    methods=[
        'GET',
        'POST'
    ]
)
def config_api():

    if not session.get(
        'admin'
    ):

        return jsonify({
            "error":
                "Unauthorized"
        }), 401


    if request.method == 'GET':

        cfg = load_thresholds()


        cfg[
            'db_host'
        ] = os.getenv(
            'PP_SQL_HOST',
            ''
        )


        cfg[
            'db_port'
        ] = os.getenv(
            'PP_SQL_PORT',
            '1433'
        )


        cfg[
            'db_name'
        ] = os.getenv(
            'PP_SQL_DATABASE',
            ''
        )


        cfg[
            'db_user'
        ] = os.getenv(
            'PP_SQL_USERNAME',
            ''
        )


        return jsonify(
            cfg
        )


    if request.method == 'POST':

        data = (
            request.json
            or {}
        )


        threshold_keys = [

            'day_production_target_mt',

            'gp3_setpoint_tph',

            'moisture_green_max',

            'moisture_yellow_max',

            'bin_starvation_pct',

            'bin_low_pct',

            'bin_overfeed_pct',

            'variance_green_tph',

            'variance_amber_tph',

            'stale_after_seconds'
        ]


        curr_t = load_thresholds()


        for k in threshold_keys:

            if k in data:

                try:

                    curr_t[k] = (

                        float(
                            data[k]
                        )

                        if '.' in str(
                            data[k]
                        )

                        else int(
                            data[k]
                        )
                    )


                except (
                    ValueError,
                    TypeError
                ):

                    pass


        with open(
            'thresholds.json',
            'w'
        ) as f:

            json.dump(
                curr_t,
                f,
                indent=4
            )


        logger.info(
            f"Configuration updated by "
            f"{request.remote_addr}"
        )


        return jsonify({
            "status":
                "ok"
        })


@app.route(
    '/api/config/test',
    methods=['POST']
)
def config_test():

    if not session.get(
        'admin'
    ):

        return jsonify({
            "error":
                "Unauthorized"
        }), 401


    try:

        conn = get_db_connection()


        if conn:

            conn.close()


            return jsonify({
                "status":
                    "ok"
            })


        return jsonify({
            "error":
                "Missing credentials or host unreachable"
        })


    except Exception as e:

        return jsonify({
            "error":
                str(e)
        })


# ---------------------------------------------------------------------------
# START SERVER
# ---------------------------------------------------------------------------

if __name__ == '__main__':

    serve(
        app,
        host='0.0.0.0',
        port=5001,
        threads=8
    )