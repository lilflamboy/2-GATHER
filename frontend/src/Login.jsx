// frontend/src/Login.jsx
import { useState } from "react";
import { auth, googleProvider } from "./firebase";
import { signInWithPopup, signInWithPhoneNumber, RecaptchaVerifier } from "firebase/auth";

const Login = ({ onLoginSuccess }) => {
  const [phoneNumber, setPhoneNumber] = useState("");
  const [otp, setOtp] = useState("");
  const [step, setStep] = useState("INPUT_PHONE"); // INPUT_PHONE | INPUT_OTP
  const [confirmationResult, setConfirmationResult] = useState(null);

  // 1. Handle Google Login
  const handleGoogleLogin = async () => {
    try {
      const result = await signInWithPopup(auth, googleProvider);
      console.log("✅ Logged in user:", result.user);
      onLoginSuccess(result.user);
    } catch (error) {
      console.error("❌ Google Login Error:", error);
      alert(error.message);
    }
  };

  // 2. Handle Phone Login (Send OTP)
  const handleSendOtp = async () => {
    try {
      if (!window.recaptchaVerifier) {
        // Firebase phone auth requires a reCAPTCHA verifier, even when the UI
        // keeps it invisible to the user.
        window.recaptchaVerifier = new RecaptchaVerifier(auth, "sign-in-button", {
          size: "invisible",
        });
      }
      
      const appVerifier = window.recaptchaVerifier;
      // The UI expects users to enter digits only, so prepend the country code here.
      const formatPh = "+" + phoneNumber; // Ensure country code is there
      
      const confirmation = await signInWithPhoneNumber(auth, formatPh, appVerifier);
      setConfirmationResult(confirmation);
      setStep("INPUT_OTP");
      alert("OTP Sent!");
    } catch (error) {
      console.error("Error sending OTP:", error);
      alert("Error sending OTP. Did you add the test number in Firebase console?");
    }
  };

  // 3. Verify OTP
  const handleVerifyOtp = async () => {
    try {
      // Firebase returns a confirmationResult from the OTP send step; verifying
      // it completes the same login flow as Google auth.
      const result = await confirmationResult.confirm(otp);
      console.log("✅ Phone User Logged In:", result.user);
      onLoginSuccess(result.user);
    } catch (error) {
      alert("Invalid OTP");
    }
  };

  return (
    <div style={{ height: "100vh", display: "flex", justifyContent: "center", alignItems: "center", background: "#000", color: "#fff", flexDirection: "column" }}>
      <h1 style={{ color: "#E50914", fontSize: "3rem", marginBottom: "20px" }}>Lumiere</h1>
      
      <div style={{ background: "#1f1f1f", padding: "40px", borderRadius: "10px", textAlign: "center", width: "350px" }}>
        
        {/* GOOGLE BUTTON */}
        <button 
          onClick={handleGoogleLogin}
          style={{ width: "100%", padding: "12px", background: "#fff", color: "#333", border: "none", borderRadius: "5px", cursor: "pointer", fontWeight: "bold", marginBottom: "20px" }}
        >
          🇬 Sign in with Google
        </button>

        <p>OR</p>

        {/* PHONE INPUT */}
        {step === "INPUT_PHONE" && (
          <>
            <input 
              type="tel" 
              placeholder="Phone (e.g. 1111111111)" 
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              style={{ width: "90%", padding: "10px", marginBottom: "10px", borderRadius: "5px", border: "none" }}
            />
            <button 
              onClick={handleSendOtp}
              id="sign-in-button"
              style={{ width: "100%", padding: "12px", background: "#E50914", color: "#fff", border: "none", borderRadius: "5px", cursor: "pointer" }}
            >
              Send OTP
            </button>
          </>
        )}

        {/* OTP INPUT */}
        {step === "INPUT_OTP" && (
          <>
            <input 
              type="text" 
              placeholder="Enter OTP" 
              value={otp}
              onChange={(e) => setOtp(e.target.value)}
              style={{ width: "90%", padding: "10px", marginBottom: "10px", borderRadius: "5px", border: "none" }}
            />
            <button 
              onClick={handleVerifyOtp}
              style={{ width: "100%", padding: "12px", background: "#28a745", color: "#fff", border: "none", borderRadius: "5px", cursor: "pointer" }}
            >
              Verify & Login
            </button>
          </>
        )}
        
        <div id="recaptcha-container"></div>
      </div>
    </div>
  );
};

export default Login;
