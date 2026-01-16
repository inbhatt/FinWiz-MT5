import customtkinter as ctk

# --- AUTHENTICATION BACKEND ---
from backend.db_manager import DatabaseManager

# --- HIGH FIDELITY THEME CONSTANTS ---
COLOR_BG = "#050806"  # The deep void background
COLOR_CARD = "#0D110F"  # Slightly lighter for the card
COLOR_INPUT_BG = "#131A16"  # Input fields
COLOR_INPUT_BORDER = "#1E2923"  # Subtle border for inputs
COLOR_ACCENT_MAIN = "#2ED162"  # The "Neon" Green
COLOR_ACCENT_HOVER = "#25A84F"  # Slightly darker green for hover
COLOR_TEXT_WHITE = "#FFFFFF"
COLOR_TEXT_GREY = "#6B7A75"  # Muted text for labels
COLOR_TEXT_PLACEHOLDER = "#3A4D45"

# FONT CONFIGURATION
FONT_HEADER = ("Roboto", 26, "bold")
FONT_SUBHEADER = ("Roboto", 13)
FONT_LABEL = ("Roboto Medium", 12)
FONT_INPUT = ("Roboto", 14)
FONT_BUTTON = ("Roboto", 15, "bold")


class FinWizApp(ctk.CTk):
    def __init__(self):
        super().__init__()

        # Window Setup
        self.title("FinWiz Trading")
        self.geometry("1280x800")
        self.configure(fg_color=COLOR_BG)

        # Database
        self.db = DatabaseManager()

        # Screens
        self.login_screen = LoginScreen(self, self.on_login_success)
        self.dashboard_screen = None

        self.login_screen.pack(fill="both", expand=True)

    def on_login_success(self):
        self.login_screen.pack_forget()
        self.dashboard_screen = DashboardScreen(self)
        self.dashboard_screen.pack(fill="both", expand=True)


class LoginScreen(ctk.CTkFrame):
    def __init__(self, master, callback):
        super().__init__(master, fg_color=COLOR_BG)
        self.callback = callback

        # --- CENTER CARD ---
        # We use a border frame to give it a subtle pop
        self.card = ctk.CTkFrame(
            self,
            width=420,
            height=620,
            fg_color=COLOR_CARD,
            corner_radius=20,
            border_width=1,
            border_color="#1A241F"
        )
        self.card.place(relx=0.5, rely=0.5, anchor="center")

        # Stop the frame from shrinking to fit widgets (allows specific sizing)
        self.card.pack_propagate(False)

        # --- LOGO & HEADER ---
        self.logo_icon = ctk.CTkButton(
            self.card, text="|||", width=54, height=54,
            fg_color="#131F18", hover=False, corner_radius=12,
            text_color=COLOR_ACCENT_MAIN, font=("Arial", 22, "bold")
        )
        self.logo_icon.pack(pady=(50, 20))

        ctk.CTkLabel(self.card, text="TradePro Terminal", font=FONT_HEADER, text_color=COLOR_TEXT_WHITE).pack(
            pady=(0, 5))
        ctk.CTkLabel(self.card, text="Professional Trading Environment", font=FONT_SUBHEADER,
                     text_color=COLOR_TEXT_GREY).pack(pady=(0, 40))

        # --- INPUT FIELD 1 (Username) ---
        self.input_frame_user = ctk.CTkFrame(self.card, fg_color="transparent")
        self.input_frame_user.pack(fill="x", padx=45, pady=(0, 20))

        ctk.CTkLabel(self.input_frame_user, text="Username or ID", font=FONT_LABEL, text_color=COLOR_TEXT_GREY).pack(
            anchor="w", pady=(0, 8))

        self.entry_user = ctk.CTkEntry(
            self.input_frame_user,
            placeholder_text="Enter your trading ID",
            placeholder_text_color=COLOR_TEXT_PLACEHOLDER,
            font=FONT_INPUT,
            height=50,  # TALLER INPUTS
            fg_color=COLOR_INPUT_BG,
            border_color=COLOR_INPUT_BORDER,
            border_width=1,
            text_color="white",
            corner_radius=8
        )
        self.entry_user.pack(fill="x")

        # --- INPUT FIELD 2 (Password) ---
        self.input_frame_pass = ctk.CTkFrame(self.card, fg_color="transparent")
        self.input_frame_pass.pack(fill="x", padx=45, pady=(0, 10))

        ctk.CTkLabel(self.input_frame_pass, text="Password", font=FONT_LABEL, text_color=COLOR_TEXT_GREY).pack(
            anchor="w", pady=(0, 8))

        self.entry_pass = ctk.CTkEntry(
            self.input_frame_pass,
            placeholder_text="••••••••••••",
            placeholder_text_color=COLOR_TEXT_PLACEHOLDER,
            font=FONT_INPUT,
            height=50,  # TALLER INPUTS
            fg_color=COLOR_INPUT_BG,
            border_color=COLOR_INPUT_BORDER,
            border_width=1,
            text_color="white",
            show="*",
            corner_radius=8
        )
        self.entry_pass.pack(fill="x")

        # --- EXTRAS (Remember Me / Forgot Pass) ---
        self.extras_frame = ctk.CTkFrame(self.card, fg_color="transparent")
        self.extras_frame.pack(fill="x", padx=45, pady=(0, 30))

        self.check = ctk.CTkCheckBox(
            self.extras_frame, text="Remember device",
            text_color=COLOR_TEXT_GREY, font=("Roboto", 12),
            border_color=COLOR_TEXT_GREY, hover_color=COLOR_ACCENT_MAIN,
            fg_color=COLOR_ACCENT_MAIN,
            checkbox_height=18, checkbox_width=18, border_width=2, corner_radius=4
        )
        self.check.pack(side="left")

        self.forgot_btn = ctk.CTkLabel(
            self.extras_frame, text="Forgot password?",
            text_color=COLOR_ACCENT_MAIN, font=("Roboto", 12, "bold"), cursor="hand2"
        )
        self.forgot_btn.pack(side="right")

        # --- MAIN ACTION BUTTON ---
        self.btn_login = ctk.CTkButton(
            self.card,
            text="Secure Login",
            font=FONT_BUTTON,
            height=55,  # BIGGER BUTTON
            fg_color=COLOR_ACCENT_MAIN,
            hover_color=COLOR_ACCENT_HOVER,
            text_color="#050806",  # Black text on green button for contrast
            corner_radius=8,
            command=self.attempt_login
        )
        self.btn_login.pack(fill="x", padx=45)

        # Error Label
        self.status_lbl = ctk.CTkLabel(self.card, text="", text_color="#FF4444", font=("Roboto", 12))
        self.status_lbl.pack(pady=15)

    def attempt_login(self):
        mobile = self.entry_user.get()
        password = self.entry_pass.get()
        self.btn_login.configure(text="Verifying...", state="disabled")
        self.update()

        success, msg = self.master.db.verify_user(mobile, password)
        if success:
            self.callback()
        else:
            self.status_lbl.configure(text=msg)
            self.btn_login.configure(text="Secure Login", state="normal")


class DashboardScreen(ctk.CTkFrame):
    def __init__(self, master):
        super().__init__(master, fg_color=COLOR_BG)

        ctk.CTkLabel(self, text="Dashboard Placeholder", text_color="white").pack(pady=100)


if __name__ == "__main__":
    app = FinWizApp()
    app.mainloop()