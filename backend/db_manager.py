import os
import sys

import firebase_admin
from firebase_admin import credentials, firestore

def get_db():
    if not firebase_admin._apps:
        try:
            cred_path = get_resource_path("serviceAccountKey.json")
            if not os.path.exists(cred_path):
                print(f"CRITICAL ERROR: Key not found at {cred_path}")
            else:
                cred = credentials.Certificate(cred_path)
                firebase_admin.initialize_app(cred)
                print(f"Firebase initialized from: {cred_path}")
        except Exception as e:
            print(f"Firebase Init Error: {e}")
    return firestore.client()

def get_resource_path(filename):
    if hasattr(sys, '_MEIPASS'):
        return os.path.join(sys._MEIPASS, filename)
    if os.path.exists(filename):
        return filename
    current_dir = os.path.dirname(os.path.abspath(__file__))
    file_in_dir = os.path.join(current_dir, filename)
    if os.path.exists(file_in_dir):
        return file_in_dir
    return filename

