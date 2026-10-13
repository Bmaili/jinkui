package androidx.biometric; public class BiometricManager {
  public static final int BIOMETRIC_SUCCESS=0, BIOMETRIC_ERROR_HW_UNAVAILABLE=1, BIOMETRIC_ERROR_NONE_ENROLLED=11, BIOMETRIC_ERROR_NO_HARDWARE=12;
  public interface Authenticators { int BIOMETRIC_STRONG=15, BIOMETRIC_WEAK=255; }
  public static BiometricManager from(android.content.Context c){ return new BiometricManager(); }
  public int canAuthenticate(int a){ return 0; } }
