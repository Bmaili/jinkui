package android.security.keystore; public abstract class KeyProperties {
  public static final int PURPOSE_ENCRYPT=1, PURPOSE_DECRYPT=2, AUTH_BIOMETRIC_STRONG=2;
  public static final String BLOCK_MODE_GCM="GCM", ENCRYPTION_PADDING_NONE="NoPadding", KEY_ALGORITHM_AES="AES"; }
