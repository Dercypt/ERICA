import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { NavigationContainer, DarkTheme, createNavigationContainerRef } from '@react-navigation/native';
import { SosScreen } from '../features/sos';
import { ContactsScreen } from '../features/contacts';
import { HistoryScreen } from '../features/history';
import { SettingsScreen } from '../features/settings';

export const navigationRef = createNavigationContainerRef();

const Tab = createBottomTabNavigator();

export function RootNavigator() {
  return (
    <NavigationContainer ref={navigationRef} theme={DarkTheme}>
      <Tab.Navigator
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: '#D7263D',
          tabBarInactiveTintColor: '#8E8E93',
          tabBarStyle: {
            backgroundColor: '#121216',
            borderTopColor: '#1C1C1E',
          },
        }}
      >
        <Tab.Screen name="SOS" component={SosScreen} />
        <Tab.Screen name="Contacts" component={ContactsScreen} />
        <Tab.Screen name="History" component={HistoryScreen} />
        <Tab.Screen name="Settings" component={SettingsScreen} />
      </Tab.Navigator>
    </NavigationContainer>
  );
}
