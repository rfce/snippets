import { createContext } from 'react';

export const TabBarContext = createContext({
  isTabBarHidden: false,
  setIsTabBarHidden: () => {},
  selectedImageIds: new Set(),
  setSelectedImageIds: () => {},
});
