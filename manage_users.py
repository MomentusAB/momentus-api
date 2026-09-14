"""Skapa, lista och inaktivera användare för mobilappen.

    python manage_users.py add <användarnamn> [--name "Visningsnamn"]
    python manage_users.py list
    python manage_users.py disable <användarnamn>

Lösenordet frågas efter interaktivt (visas inte). Kör i samma mapp som .env.
"""

import argparse
import getpass
import sys

import auth
import db


def main():
    parser = argparse.ArgumentParser(description="Hantera användare för Momentus API")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_add = sub.add_parser("add", help="Skapa användare (eller byt lösenord på befintlig)")
    p_add.add_argument("username")
    p_add.add_argument("--name", default=None, help="Visningsnamn")

    sub.add_parser("list", help="Lista användare")

    p_dis = sub.add_parser("disable", help="Inaktivera användare och logga ut alla enheter")
    p_dis.add_argument("username")

    args = parser.parse_args()

    conn = db.get_connection(use_dict_row=True)
    db.ensure_schema(conn)
    auth.ensure_auth_schema(conn)

    if args.cmd == "add":
        pw = getpass.getpass("Lösenord (minst 8 tecken): ")
        pw2 = getpass.getpass("Upprepa lösenord: ")
        if pw != pw2:
            print("Lösenorden matchar inte.")
            sys.exit(1)
        user = auth.create_user(conn, args.username, pw, args.name)
        print(f"Användare klar: {user['username']} ({user['display_name']})")

    elif args.cmd == "list":
        for u in auth.list_users(conn):
            status = "aktiv" if u["is_active"] else "inaktiv"
            print(f"{u['id']:>4}  {u['username']:<20} {u['display_name'] or '':<24} {status}")

    elif args.cmd == "disable":
        n = auth.deactivate_user(conn, args.username)
        print("Användaren inaktiverad." if n else "Ingen sådan användare.")


if __name__ == "__main__":
    main()
