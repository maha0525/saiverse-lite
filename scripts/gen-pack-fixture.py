"""Generates src/pack/__fixtures__/: a small persona pack and the rows it was written from.

The persona is synthetic and lives in a temporary SAIVERSE_HOME. Nothing reads ~/.saiverse.
The tables are made by the body's own init functions and the pack by its export_persona_pack,
so the ZIP has the shape the body writes today. Run it from a checkout of the body:

    cd C:\\Users\\shuhe\\workspace\\SAIVerse-lite-memory
    C:\\Users\\shuhe\\workspace\\SAIVerse\\.venv\\Scripts\\python.exe <lite>\\scripts\\gen-pack-fixture.py

expected.json is read back from the two SQLite files after the export, so the test compares
what Lite stored with the database, not with the ZIP.
"""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import struct
import sys
import tempfile
import zlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

OUT_DIR = Path(__file__).resolve().parent.parent / "src" / "pack" / "__fixtures__"
PERSONA_ID = "pack_fixture_city_a"
ROOM_ID = "pack_fixture_room_city_a"
T0 = 1_760_000_000


def tiny_png() -> bytes:
    """A 1x1 opaque cyan PNG."""
    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    header = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(b"\x00\x06\xb6\xd4")) + chunk(b"IEND", b"")


def build_world(home: Path) -> tuple[Path, Path]:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session

    from database.models import AI, Base, Building
    from sai_memory.arasuji.storage import create_entry, init_arasuji_tables
    from sai_memory.clips import init_clips_tables
    from sai_memory.core_memory import add_core_memory, init_core_memory_table, remove_core_memory
    from sai_memory.desk import init_desk_tables
    from sai_memory.memopedia.storage import create_fragment, create_page, init_memopedia_tables
    from sai_memory.memory.storage import init_db
    from sai_memory.perception_buffer import init_perception_buffer_table
    from sai_memory.purpose_tags import init_purpose_tags_tables

    for folder in ("image", "user_data/icons", "user_data/database"):
        (home / folder).mkdir(parents=True)
    persona_dir = home / "personas" / PERSONA_ID
    persona_dir.mkdir(parents=True)

    icon = home / "user_data" / "icons" / "fixture_icon.png"
    icon.write_bytes(tiny_png())
    (home / "image" / "pic.png").write_bytes(tiny_png())
    (home / "image" / "pic.png.summary.txt").write_text("一画素の絵", encoding="utf-8")
    (persona_dir / "active_state.json").write_text(
        json.dumps({"active_thread_id": "room_a", "updated_at": "2026-10-01T00:00:00"}), encoding="utf-8"
    )

    world_db = home / "user_data" / "database" / "saiverse.db"
    engine = create_engine(f"sqlite:///{world_db.as_posix()}")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        session.add(AI(
            AIID=PERSONA_ID, HOME_CITYID=1, AINAME="試料の子",
            SYSTEMPROMPT="あなたは試料の子です。", DESCRIPTION="取り込みの検査に使う合成ペルソナ",
            AVATAR_IMAGE=str(icon), PRIVATE_ROOM_ID=ROOM_ID,
        ))
        session.add(Building(CITYID=1, BUILDINGID=ROOM_ID, BUILDINGNAME="試料の部屋"))
        session.commit()
    engine.dispose()

    memory_db = persona_dir / "memory.db"
    conn = init_db(str(memory_db))
    init_memopedia_tables(conn)
    init_core_memory_table(conn)
    init_arasuji_tables(conn)
    init_clips_tables(conn)
    init_purpose_tags_tables(conn)
    init_desk_tables(conn)
    init_perception_buffer_table(conn)

    conn.execute(
        "INSERT INTO threads(id, resource_id, overview, overview_updated_at, title) VALUES (?,?,?,?,?)",
        (f"{PERSONA_ID}:__persona__", PERSONA_ID, "概要", T0, "試料の会話"),
    )
    conn.execute("INSERT INTO threads(id, resource_id) VALUES (?,?)", (f"{PERSONA_ID}:room_a", PERSONA_ID))
    conn.execute("INSERT INTO threads(id, resource_id) VALUES (?,?)", (f"{PERSONA_ID}:stelis_1", PERSONA_ID))
    conn.execute(
        "INSERT INTO stelis_threads(thread_id, parent_thread_id, depth, status, created_at, label) VALUES (?,?,?,?,?,?)",
        (f"{PERSONA_ID}:stelis_1", None, 0, "completed", T0 + 50, "試料の Stelis"),
    )

    def add(mid: str, thread: str, role: str, content: str, created: int, metadata: Any, **columns: Any) -> None:
        text = metadata if isinstance(metadata, str) or metadata is None else json.dumps(metadata, ensure_ascii=False)
        names = ["id", "thread_id", "role", "content", "resource_id", "created_at", "metadata", *columns]
        values = [mid, f"{PERSONA_ID}:{thread}", role, content, PERSONA_ID, created, text, *columns.values()]
        conn.execute(f"INSERT INTO messages({', '.join(names)}) VALUES ({', '.join('?' * len(names))})", values)

    conversation = {"tags": ["conversation"]}
    # Three rows in one second, across two threads: only seq keeps their order.
    add("m-01", "__persona__", "user", "こんにちは", T0, {
        **conversation, "images": [{"uri": "saiverse://image/pic.png", "mime_type": "image/png"}],
    })
    add("m-02", "room_a", "assistant", "別の部屋の返事", T0, conversation, thought_signature=bytes(range(256)), pulse_id="pulse-1")
    add("m-03", "__persona__", "assistant", "  前後の空白も本文  ", T0, conversation, thought_signature=b"\x00\x01\xff", line_role="main_line", pulse_id="pulse-2")
    add("m-04", "__persona__", "model", "古い書き手の返事", T0 + 1, conversation, line_role="main_line")
    add("m-05", "__persona__", "system", "[Handy Tool: memory_recall]\n結果", T0 + 2, {
        "tags": ["conversation", "handy_tool"], "__system_notice__": "handy_tool",
    }, pulse_id="pulse-2")
    add("m-06", "__persona__", "host", "一方的な通知", T0 + 3, conversation)
    add("m-07", "__persona__", "assistant", "内心のつぶやき", T0 + 4, {"tags": ["internal"]}, line_role="sub_line")
    add("m-08", "__persona__", "assistant", "途中で消える行", T0 + 5, conversation, scope="volatile")
    add("m-09", "__persona__", "assistant", "行動の前の発話", T0 + 6, conversation, paired_action_text="（お茶を淹れた）")
    add("m-10", "__persona__", "user", "見つからない添付", T0 + 7, {
        **conversation, "media": [{"type": "audio", "uri": "saiverse://audio/gone.ogg"}],
    })
    add("m-11", "room_a", "user", "metadata が文字列の null の行", T0 + 8, "null")
    add("m-12", "room_a", "user", "metadata が解釈できない文字列の行", T0 + 9, "{not json")
    add("m-13", "room_a", "user", "印と同じ形の利用者の値", T0 + 10, {"__raw_text__": "利用者の文字列"})
    add("m-14", "room_a", "assistant", "metadata が無い行", T0 + 11, None)
    add("m-15", "stelis_1", "assistant", "Stelis の中の発話", T0 + 50, conversation)
    add("m-16", "__persona__", "user", "改行\nと \"引用符\" と \\ と 🌸 を含む本文", T0 + 60, conversation)
    conn.commit()

    alice = create_page(
        conn, parent_id="root_people", title="アリス", summary="近所の友人", content="猫を飼っている。",
        category="people", keywords=["友人", "猫"], vividness="vivid",
    )
    gone = create_page(conn, parent_id="root_events", title="取り消した出来事", content="消した。", category="events")
    conn.execute("UPDATE memopedia_pages SET is_deleted = 1 WHERE id = ?", (gone.id,))
    conn.execute("UPDATE memopedia_pages SET is_important = 1, last_referenced_at = ? WHERE id = ?", (T0 + 7, alice.id))

    add_core_memory(conn, "忘れたくないこと")
    removed = add_core_memory(conn, "消したコア記憶")
    remove_core_memory(conn, removed)

    first = create_entry(
        conn, level=1, content="最初の一次あらすじ", source_ids=["m-01", "m-03", "m-04"],
        start_time=T0, end_time=T0 + 1, source_count=3, message_count=3, entry_id="ch-1",
    )
    second = create_entry(
        conn, level=1, content="別の部屋の一次あらすじ", source_ids=["m-02"],
        start_time=T0, end_time=T0, source_count=1, message_count=1, entry_id="ch-2",
    )
    create_entry(
        conn, level=2, content="二次あらすじ", source_ids=[first.id, second.id],
        start_time=T0, end_time=T0 + 1, source_count=2, message_count=4, entry_id="ch-3",
    )
    create_fragment(
        conn, content="アリスは猫を飼っている", entity_id=alice.id, chronicle_entry_id=first.id,
        source_date="2025-10-09",
    )
    create_fragment(conn, content="日付の無い断片", entity_id=alice.id)
    conn.commit()
    conn.close()
    return world_db, memory_db


def rows(conn: sqlite3.Connection, sql: str) -> list[dict[str, Any]]:
    cursor = conn.execute(sql)
    names = [column[0] for column in cursor.description]
    return [dict(zip(names, row)) for row in cursor]


def read_expected(world_db: Path, memory_db: Path) -> dict[str, Any]:
    memory = sqlite3.connect(memory_db)
    world = sqlite3.connect(world_db)
    try:
        ai = rows(world, f"SELECT AINAME, SYSTEMPROMPT, DESCRIPTION FROM ai WHERE AIID = '{PERSONA_ID}'")[0]
        return {
            "persona_id": PERSONA_ID,
            "ai": ai,
            "threads": rows(memory, "SELECT id, title, overview_updated_at FROM threads ORDER BY id"),
            "stelis_threads": rows(memory, "SELECT thread_id, label FROM stelis_threads ORDER BY thread_id"),
            "messages": rows(
                memory,
                "SELECT rowid AS seq, id, thread_id, role, content, created_at, scope, line_role, pulse_id, "
                "paired_action_text, metadata FROM messages ORDER BY id",
            ),
            "pages": rows(
                memory,
                "SELECT id, parent_id, title, summary, content, category, created_at, updated_at, keywords, "
                "metadata, is_deleted, vividness, is_trunk, is_important, last_referenced_at, short_id "
                "FROM memopedia_pages ORDER BY id",
            ),
            "fragments": rows(
                memory,
                "SELECT id, content, entity_id, chronicle_entry_id, vividness, source_date, created_at "
                "FROM memopedia_fragments ORDER BY id",
            ),
        }
    finally:
        memory.close()
        world.close()


def main() -> None:
    sys.path.insert(0, os.getcwd())
    with tempfile.TemporaryDirectory(prefix="saiverse-pack-fixture-", ignore_cleanup_errors=True) as scratch:
        home = Path(scratch) / "home"
        os.environ["SAIVERSE_HOME"] = str(home)
        world_db, memory_db = build_world(home)
        from saiverse_memory.persona_pack import export_persona_pack

        partial = Path(scratch) / "persona_pack_fixture.zip"
        result = export_persona_pack(
            PERSONA_ID, saiverse_db_path=world_db, saiverse_home=home, output_path=partial,
            generator_version="fixture", now=datetime(2026, 10, 31, tzinfo=timezone.utc),
        )
        expected = read_expected(world_db, memory_db)
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(partial, OUT_DIR / "persona_pack_fixture.zip")
        (OUT_DIR / "persona_pack_fixture.expected.json").write_text(
            json.dumps(expected, ensure_ascii=False, indent=1) + "\n", encoding="utf-8",
        )
        print("counts", result.counts)
        print("contents", result.contents)
        print("missing_files", result.missing_files)
        print("absent_tables", result.absent_tables)


if __name__ == "__main__":
    main()
