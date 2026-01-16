import firebase_admin
from firebase_admin import credentials, firestore


class DatabaseManager:
    def __init__(self):
        # Prevent initializing the app multiple times
        if not firebase_admin._apps:
            # Ensure 'serviceAccountKey.json' is in your project folder
            cred = credentials.Certificate("serviceAccountKey.json")
            firebase_admin.initialize_app(cred)

        self.db = firestore.client()

    def verify_user(self, mobile, password):
        """
        Checks if a document exists in USERS with matching MOBILE and PASS.
        """
        try:
            # 1. Target the 'USERS' collection
            users_ref = self.db.collection('USERS')

            # 2. Query for Mobile and the specific 'PASS' field
            query = users_ref.where('MOBILE', '==', mobile).where('PASS', '==', password).stream()

            # If the query returns any documents, the login is valid
            for user in query:
                # You can also fetch the user's name if stored, e.g., user.to_dict().get('NAME')
                return True, "Login Successful"

            return False, "Invalid Mobile Number or Password"

        except Exception as e:
            return False, f"Connection Error: {e}"